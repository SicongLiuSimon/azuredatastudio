/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';

export const IAuthenticationTokenService = createDecorator<IAuthenticationTokenService>('IAuthenticationTokenService');

export interface IUserDataSyncAuthToken {
	readonly authenticationProviderId: string;
	readonly token: string;
}

export interface IAuthenticationTokenService {
	_serviceBrand: undefined;

	readonly token: IUserDataSyncAuthToken | undefined;
	readonly onDidChangeToken: Event<IUserDataSyncAuthToken | undefined>;

	setToken(userDataSyncAuthToken: IUserDataSyncAuthToken | undefined): Promise<void>;

	readonly onTokenFailed: Event<void>;
	sendTokenFailed(): void;
}

export class AuthenticationTokenService extends Disposable implements IAuthenticationTokenService {

	_serviceBrand: any;

	private _token: IUserDataSyncAuthToken | undefined;
	get token(): IUserDataSyncAuthToken | undefined { return this._token; }
	private _onDidChangeToken = this._register(new Emitter<IUserDataSyncAuthToken | undefined>());
	readonly onDidChangeToken = this._onDidChangeToken.event;

	private _onTokenFailed: Emitter<void> = this._register(new Emitter<void>());
	readonly onTokenFailed: Event<void> = this._onTokenFailed.event;


	async setToken(token: IUserDataSyncAuthToken | undefined): Promise<void> {
		if (token && this._token ? token.token !== this._token.token || token.authenticationProviderId !== this._token.authenticationProviderId : token !== this._token) {
			this._token = token;
			this._onDidChangeToken.fire(token);
		}
	}

	sendTokenFailed(): void {
		this.setToken(undefined);
		this._onTokenFailed.fire();
	}
}

