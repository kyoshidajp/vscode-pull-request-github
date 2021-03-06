/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { IAccount } from '../github/interface';
import { PullRequestManager, PRManagerState, NO_MILESTONE } from '../github/pullRequestManager';
import { MilestoneModel } from '../github/milestoneModel';
import { API as GitAPI, GitExtension } from '../typings/git';
import { ISSUES_CONFIGURATION } from './util';
import { CurrentIssue } from './currentIssue';

// TODO: make exclude from date words configurable
const excludeFromDate: string[] = ['Recovery'];
const CUSTOM_QUERY_CONFIGURATION = 'customQuery';
const CURRENT_ISSUE_KEY = 'currentIssue';

const ISSUES_KEY = 'issues';

export interface IssueState {
	branch?: string;
}

interface TimeStampedIssueState extends IssueState {
	stateModifiedTime: number;
}

interface IssuesState {
	issues: Record<string, TimeStampedIssueState>;
}

export class StateManager {
	public readonly resolvedIssues: LRUCache<string, IssueModel> = new LRUCache(50); // 50 seems big enough
	public readonly userMap: Map<string, IAccount> = new Map();
	private _lastHead: string | undefined;
	private _milestones: Promise<MilestoneModel[]> = Promise.resolve([]);
	private _issues: Promise<IssueModel[]> = Promise.resolve([]);
	private _onRefreshCacheNeeded: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onRefreshCacheNeeded: vscode.Event<void> = this._onRefreshCacheNeeded.event;
	private _onDidChangeIssueData: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onDidChangeIssueData: vscode.Event<void> = this._onDidChangeIssueData.event;
	private _query: string | undefined;

	private _currentIssue: CurrentIssue | undefined;
	private _onDidChangeCurrentIssue: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeCurrentIssue: vscode.Event<void> = this._onDidChangeCurrentIssue.event;

	get issueData(): { byMilestone?: Promise<MilestoneModel[]>, byIssue?: Promise<IssueModel[]> } {
		return this._query ? { byIssue: this._issues } : { byMilestone: this._milestones };
	}

	constructor(private manager: PullRequestManager, private context: vscode.ExtensionContext) { }

	async initialize() {
		return new Promise(resolve => {
			if (this.manager.state === PRManagerState.RepositoriesLoaded) {
				this.doInitialize();
				resolve();
			} else {
				const disposable = this.manager.onDidChangeState(() => {
					if (this.manager.state === PRManagerState.RepositoriesLoaded) {
						this.doInitialize();
						disposable.dispose();
						resolve();
					}
				});
				this.context.subscriptions.push(disposable);
			}
		});
	}

	private registerRepositoryChangeEvent() {
		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports;
		const git: GitAPI = gitExtension.getAPI(1);
		git.repositories.forEach(repository => {
			this.context.subscriptions.push(repository.state.onDidChange(() => {
				if ((repository.state.HEAD ? repository.state.HEAD.commit : undefined) !== this._lastHead) {
					this._lastHead = (repository.state.HEAD ? repository.state.HEAD.commit : undefined);
					this.setIssueData();
				}
			}));
		});
	}

	refreshCacheNeeded() {
		this._onRefreshCacheNeeded.fire();
	}

	private async doInitialize() {
		this.cleanIssueState();
		this._query = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(CUSTOM_QUERY_CONFIGURATION, undefined);
		this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(change => {
			if (change.affectsConfiguration(`${ISSUES_CONFIGURATION}.${CUSTOM_QUERY_CONFIGURATION}`)) {
				this._query = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(CUSTOM_QUERY_CONFIGURATION, undefined);
				this._onRefreshCacheNeeded.fire();
			}
		}));
		this._lastHead = this.manager.repository.state.HEAD ? this.manager.repository.state.HEAD.commit : undefined;
		await this.setUsers();
		await this.setIssueData();
		this.registerRepositoryChangeEvent();
		this.context.subscriptions.push(this.onRefreshCacheNeeded(() => {
			this.setIssueData();
		}));
	}

	private cleanIssueState() {
		const stateString: string | undefined = this.context.workspaceState.get(ISSUES_KEY);
		const state: IssuesState = stateString ? JSON.parse(stateString) : { issues: [] };
		const deleteDate: number = new Date().valueOf() - (30 /*days*/ * 86400000 /*milliseconds in a day*/);
		for (let issueState in state.issues) {
			if (state.issues[issueState].stateModifiedTime < deleteDate) {
				delete state.issues[issueState];
			}
		}
	}

	async setUsers() {
		const assignableUsers = await this.manager.getAssignableUsers();
		for (const remote in assignableUsers) {
			assignableUsers[remote].forEach(account => {
				this.userMap.set(account.login, account);
			});
		}
	}

	private setIssueData() {
		if (this._query) {
			this._milestones = Promise.resolve([]);
			this._issues = this.setIssues();
		} else {
			this._issues = Promise.resolve([]);
			this._milestones = this.setMilestones();
		}
	}

	private setIssues(): Promise<IssueModel[]> {
		return new Promise(async (resolve) => {
			const issues = await this.manager.getIssues({ fetchNextPage: false }, this._query);
			this._onDidChangeIssueData.fire();
			this.tryRestoreCurrentIssue(issues.items);
			resolve(issues.items);
		});
	}

	private tryRestoreCurrentIssue(issues: IssueModel[]) {
		const restoreIssueNumber = this.context.workspaceState.get(CURRENT_ISSUE_KEY);
		if (restoreIssueNumber && this.currentIssue === undefined) {
			for (let i = 0; i < issues.length; i++) {
				if (issues[i].number === restoreIssueNumber) {
					new CurrentIssue(issues[i], this.manager, this, this.context).startWorking();
					return;
				}
			}
		}
	}

	private setMilestones(): Promise<MilestoneModel[]> {
		return new Promise(async (resolve) => {
			const now = new Date();
			const skipMilestones: string[] = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('ignoreMilestones', []);
			const milestones = await this.manager.getMilestones({ fetchNextPage: false }, skipMilestones.indexOf(NO_MILESTONE) < 0);
			let mostRecentPastTitleTime: Date | undefined = undefined;
			const milestoneDateMap: Map<string, Date> = new Map();
			const milestonesToUse: MilestoneModel[] = [];

			// The number of milestones is expected to be very low, so two passes through is negligible
			for (let i = 0; i < milestones.items.length; i++) {
				const item = milestones.items[i];
				const milestone = milestones.items[i].milestone;
				if ((item.issues && item.issues.length <= 0) || (skipMilestones.indexOf(milestone.title) >= 0)) {
					continue;
				}

				this.tryRestoreCurrentIssue(item.issues);
				milestonesToUse.push(item);
				let milestoneDate = milestone.dueOn ? new Date(milestone.dueOn) : undefined;
				if (!milestoneDate) {
					milestoneDate = new Date(this.removeDateExcludeStrings(milestone.title));
					if (isNaN(milestoneDate.getTime())) {
						milestoneDate = new Date(milestone.createdAt!);
					}
				}
				if ((milestoneDate < now) && ((mostRecentPastTitleTime === undefined) || (milestoneDate > mostRecentPastTitleTime))) {
					mostRecentPastTitleTime = milestoneDate;
				}
				milestoneDateMap.set(milestone.id ? milestone.id : milestone.title, milestoneDate);
			}

			milestonesToUse.sort((a: MilestoneModel, b: MilestoneModel): number => {
				const dateA = milestoneDateMap.get(a.milestone.id ? a.milestone.id : a.milestone.title)!;
				const dateB = milestoneDateMap.get(b.milestone.id ? b.milestone.id : b.milestone.title)!;
				if (mostRecentPastTitleTime && (dateA >= mostRecentPastTitleTime) && (dateB >= mostRecentPastTitleTime)) {
					return dateA <= dateB ? -1 : 1;
				} else {
					return dateA >= dateB ? -1 : 1;
				}
			});
			this._onDidChangeIssueData.fire();
			resolve(milestonesToUse);
		});
	}

	private removeDateExcludeStrings(possibleDate: string): string {
		excludeFromDate.forEach(exclude => possibleDate = possibleDate.replace(exclude, ''));
		return possibleDate;
	}

	get currentIssue(): CurrentIssue | undefined {
		return this._currentIssue;
	}

	set currentIssue(issue: CurrentIssue | undefined) {
		if (this._currentIssue) {
			this._currentIssue.dispose();
		}
		this.context.workspaceState.update(CURRENT_ISSUE_KEY, issue?.issue.number);
		this._currentIssue = issue;
		this._onDidChangeCurrentIssue.fire();
	}

	getSavedIssueState(issueNumber: number): IssueState {
		const stateString: string | undefined = this.context.workspaceState.get(ISSUES_KEY);
		const state: IssuesState = stateString ? JSON.parse(stateString) : { issues: [] };
		return state.issues[`${issueNumber}`] ?? {};
	}

	setSavedIssueState(issueNumber: number, issueState: IssueState) {
		const stateString: string | undefined = this.context.workspaceState.get(ISSUES_KEY);
		const state: IssuesState = stateString ? JSON.parse(stateString) : { issues: Object.create(null) };
		state.issues[`${issueNumber}`] = { ...issueState, stateModifiedTime: (new Date().valueOf()) };
		this.context.workspaceState.update(ISSUES_KEY, JSON.stringify(state));
	}
}