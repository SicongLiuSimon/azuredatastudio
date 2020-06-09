/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as xmldom from 'xmldom';
import * as constants from '../common/constants';
import * as utils from '../common/utils';

import { Uri } from 'vscode';
import { promises as fs } from 'fs';
import { DataSource } from './dataSources/dataSources';

/**
 * Class representing a Project, and providing functions for operating on it
 */
export class Project {
	public projectFilePath: string;
	public projectFileName: string;
	public files: ProjectEntry[] = [];
	public dataSources: DataSource[] = [];
	public importedTargets: string[] = [];
	public sqlCmdVariables: Record<string, string> = {};

	public get projectFolderPath() {
		return path.dirname(this.projectFilePath);
	}

	private projFileXmlDoc: any = undefined;

	constructor(projectFilePath: string) {
		this.projectFilePath = projectFilePath;
		this.projectFileName = path.basename(projectFilePath, '.sqlproj');
	}

	/**
	 * Reads the project setting and contents from the file
	 */
	public async readProjFile() {
		const projFileText = await fs.readFile(this.projectFilePath);
		this.projFileXmlDoc = new xmldom.DOMParser().parseFromString(projFileText.toString());

		// find all folders and files to include
		for (let ig = 0; ig < this.projFileXmlDoc.documentElement.getElementsByTagName(constants.ItemGroup).length; ig++) {
			const itemGroup = this.projFileXmlDoc.documentElement.getElementsByTagName(constants.ItemGroup)[ig];

			for (let b = 0; b < itemGroup.getElementsByTagName(constants.Build).length; b++) {
				this.files.push(this.createProjectEntry(itemGroup.getElementsByTagName(constants.Build)[b].getAttribute(constants.Include), EntryType.File));
			}

			for (let f = 0; f < itemGroup.getElementsByTagName(constants.Folder).length; f++) {
				this.files.push(this.createProjectEntry(itemGroup.getElementsByTagName(constants.Folder)[f].getAttribute(constants.Include), EntryType.Folder));
			}
		}

		// find all import statements to include
		for (let i = 0; i < this.projFileXmlDoc.documentElement.getElementsByTagName(constants.Import).length; i++) {
			const importTarget = this.projFileXmlDoc.documentElement.getElementsByTagName(constants.Import)[i];
			this.importedTargets.push(importTarget.getAttribute(constants.Project));
		}

		// find all SQLCMD variables to include
		for (let i = 0; i < this.projFileXmlDoc.documentElement.getElementsByTagName(constants.SqlCmdVariable).length; i++) {
			const sqlCmdVar = this.projFileXmlDoc.documentElement.getElementsByTagName(constants.SqlCmdVariable)[i];
			const varName = sqlCmdVar.getAttribute(constants.Include);

			const varValue = sqlCmdVar.getElementsByTagName(constants.DefaultValue)[0].childNodes[0].nodeValue;
			this.sqlCmdVariables[varName] = varValue;
		}
	}

	public async updateProjectForRoundTrip() {
		await fs.copyFile(this.projectFilePath, this.projectFilePath + '_backup');
		await this.updateImportToSupportRoundTrip();
		await this.updatePackageReferenceInProjFile();
	}

	private async updateImportToSupportRoundTrip(): Promise<void> {
		// update an SSDT project to include Net core target information
		for (let i = 0; i < this.projFileXmlDoc.documentElement.getElementsByTagName(constants.Import).length; i++) {
			const importTarget = this.projFileXmlDoc.documentElement.getElementsByTagName(constants.Import)[i];

			let condition = importTarget.getAttribute(constants.Condition);
			let projectAttributeVal = importTarget.getAttribute(constants.Project);

			if (condition === constants.SqlDbPresentCondition && projectAttributeVal === constants.SqlDbTargets) {
				await this.updateImportedTargetsToProjFile(constants.RoundTripSqlDbPresentCondition, projectAttributeVal, importTarget);
			}
			if (condition === constants.SqlDbNotPresentCondition && projectAttributeVal === constants.MsBuildtargets) {
				await this.updateImportedTargetsToProjFile(constants.RoundTripSqlDbNotPresentCondition, projectAttributeVal, importTarget);
			}
		}

		await this.updateImportedTargetsToProjFile(constants.NetCoreCondition, constants.NetCoreTargets, undefined);
	}

	/**
	 * Adds a folder to the project, and saves the project file
	 * @param relativeFolderPath Relative path of the folder
	 */
	public async addFolderItem(relativeFolderPath: string): Promise<ProjectEntry> {
		const absoluteFolderPath = path.join(this.projectFolderPath, relativeFolderPath);

		//If folder doesn't exist, create it
		let exists = await utils.exists(absoluteFolderPath);
		if (!exists) {
			await fs.mkdir(absoluteFolderPath, { recursive: true });
		}

		const folderEntry = this.createProjectEntry(relativeFolderPath, EntryType.Folder);
		this.files.push(folderEntry);

		await this.addToProjFile(folderEntry);
		return folderEntry;
	}

	/**
	 * Writes a file to disk if contents are provided, adds that file to the project, and writes it to disk
	 * @param relativeFilePath Relative path of the file
	 * @param contents Contents to be written to the new file
	 */
	public async addScriptItem(relativeFilePath: string, contents?: string): Promise<ProjectEntry> {
		const absoluteFilePath = path.join(this.projectFolderPath, relativeFilePath);

		if (contents) {
			await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
			await fs.writeFile(absoluteFilePath, contents);
		}

		//Check that file actually exists
		let exists = await utils.exists(absoluteFilePath);
		if (!exists) {
			throw new Error(constants.noFileExist(absoluteFilePath));
		}

		const fileEntry = this.createProjectEntry(relativeFilePath, EntryType.File);
		this.files.push(fileEntry);

		await this.addToProjFile(fileEntry);

		return fileEntry;
	}

	/**
	 * Set the compat level of the project
	 * Just used in tests right now, but can be used later if this functionality is added to the UI
	 * @param compatLevel compat level of project
	 */
	public changeDSP(compatLevel: string): void {
		const newDSP = `${constants.MicrosoftDatatoolsSchemaSqlSql}${compatLevel}${constants.databaseSchemaProvider}`;
		this.projFileXmlDoc.getElementsByTagName(constants.DSP)[0].childNodes[0].nodeValue = newDSP;
	}

	/**
	 * Adds reference to the appropriate master dacpac to the project
	 */
	public async addMasterDatabaseReference(): Promise<void> {
		const uri = this.getMasterDacpac();
		this.addDatabaseReference(uri, DatabaseReferenceLocation.differentDatabaseSameServer, constants.master);
	}

	public getMasterDacpac(): Uri {
		// check for invalid DSP
		if (this.projFileXmlDoc.getElementsByTagName(constants.DSP).length !== 1 || this.projFileXmlDoc.getElementsByTagName(constants.DSP)[0].childNodes.length !== 1) {
			throw new Error(constants.invalidDataSchemaProvider);
		}

		let dsp: string = this.projFileXmlDoc.getElementsByTagName(constants.DSP)[0].childNodes[0].nodeValue;

		// get version from dsp, which is a string like Microsoft.Data.Tools.Schema.Sql.Sql130DatabaseSchemaProvider
		// remove part before the number
		let version: any = dsp.substring(constants.MicrosoftDatatoolsSchemaSqlSql.length);
		// remove DatabaseSchemaProvider
		version = version.substring(0, version.length - constants.databaseSchemaProvider.length);

		// make sure version is valid
		console.error(Object.values(TargetPlatform));
		if (!Object.values(TargetPlatform).includes(version)) {
			throw new Error(constants.invalidDataSchemaProvider);
		}

		return Uri.parse(path.join('$(NETCoreTargetsPath)', 'SystemDacpacs', version, 'master.dacpac'));
	}

	/**
	 * Adds reference to a dacpac to the project
	 * @param uri Uri of the dacpac
	 * @param databaseName name of the database
	 */
	public async addDatabaseReference(uri: Uri, databaseLocation: DatabaseReferenceLocation, databaseName?: string): Promise<void> {
		let databaseReferenceEntry = new DatabaseReferenceProjectEntry(uri, databaseLocation, databaseName);
		await this.addToProjFile(databaseReferenceEntry);
	}

	public createProjectEntry(relativePath: string, entryType: EntryType): ProjectEntry {
		return new ProjectEntry(Uri.file(path.join(this.projectFolderPath, relativePath)), relativePath, entryType);
	}

	private findOrCreateItemGroup(containedTag?: string): any {
		let outputItemGroup = undefined;

		// search for a particular item goup if a child type is provided
		if (containedTag) {
			// find any ItemGroup node that contains files; that's where we'll add
			for (let ig = 0; ig < this.projFileXmlDoc.documentElement.getElementsByTagName(constants.ItemGroup).length; ig++) {
				const currentItemGroup = this.projFileXmlDoc.documentElement.getElementsByTagName(constants.ItemGroup)[ig];

				// if we find the tag, use the ItemGroup
				if (currentItemGroup.getElementsByTagName(containedTag).length > 0) {
					outputItemGroup = currentItemGroup;
					break;
				}
			}
		}

		// if none already exist, make a new ItemGroup for it
		if (!outputItemGroup) {
			outputItemGroup = this.projFileXmlDoc.createElement(constants.ItemGroup);
			this.projFileXmlDoc.documentElement.appendChild(outputItemGroup);
		}

		return outputItemGroup;
	}

	private addFileToProjFile(path: string) {
		const newFileNode = this.projFileXmlDoc.createElement(constants.Build);
		newFileNode.setAttribute(constants.Include, path);

		this.findOrCreateItemGroup(constants.Build).appendChild(newFileNode);
	}

	private addFolderToProjFile(path: string) {
		const newFolderNode = this.projFileXmlDoc.createElement(constants.Folder);
		newFolderNode.setAttribute(constants.Include, path);

		this.findOrCreateItemGroup(constants.Folder).appendChild(newFolderNode);
	}

	private addDatabaseReferenceToProjFile(entry: DatabaseReferenceProjectEntry): void {
		const referenceNode = this.projFileXmlDoc.createElement(constants.ArtifactReference);
		referenceNode.setAttribute(constants.Condition, constants.NetCoreCondition);
		referenceNode.setAttribute(constants.Include, entry.fsUri.fsPath);

		let suppressMissingDependenciesErrorNode = this.projFileXmlDoc.createElement(constants.SuppressMissingDependenciesErrors);
		let falseTextNode = this.projFileXmlDoc.createTextNode('False');
		suppressMissingDependenciesErrorNode.appendChild(falseTextNode);
		referenceNode.appendChild(suppressMissingDependenciesErrorNode);

		if (entry.databaseLocation === DatabaseReferenceLocation.differentDatabaseSameServer) {
			let databaseVariableLiteralValue = this.projFileXmlDoc.createElement(constants.DatabaseVariableLiteralValue);
			let databaseTextNode = this.projFileXmlDoc.createTextNode(entry.name);
			databaseVariableLiteralValue.appendChild(databaseTextNode);
			referenceNode.appendChild(databaseVariableLiteralValue);
		}

		this.findOrCreateItemGroup().appendChild(referenceNode);
	}

	private async updateImportedTargetsToProjFile(condition: string, projectAttributeVal: string, oldImportNode?: any): Promise<any> {
		const importNode = this.projFileXmlDoc.createElement(constants.Import);
		importNode.setAttribute(constants.Condition, condition);
		importNode.setAttribute(constants.Project, projectAttributeVal);

		if (oldImportNode) {
			this.projFileXmlDoc.documentElement.replaceChild(importNode, oldImportNode);
		}
		else {
			this.projFileXmlDoc.documentElement.appendChild(importNode, oldImportNode);
			this.importedTargets.push(projectAttributeVal);	// Add new import target to the list
		}

		await this.serializeToProjFile(this.projFileXmlDoc);
		return importNode;
	}

	private async updatePackageReferenceInProjFile(): Promise<void> {
		const packageRefNode = this.projFileXmlDoc.createElement(constants.PackageReference);
		packageRefNode.setAttribute(constants.Condition, constants.NetCoreCondition);
		packageRefNode.setAttribute(constants.Include, constants.NETFrameworkAssembly);
		packageRefNode.setAttribute(constants.Version, constants.VersionNumber);
		packageRefNode.setAttribute(constants.PrivateAssets, constants.All);

		this.findOrCreateItemGroup(constants.PackageReference).appendChild(packageRefNode);

		await this.serializeToProjFile(this.projFileXmlDoc);
	}

	private async addToProjFile(entry: ProjectEntry) {
		switch (entry.type) {
			case EntryType.File:
				this.addFileToProjFile(entry.relativePath);
				break;
			case EntryType.Folder:
				this.addFolderToProjFile(entry.relativePath);
			case EntryType.DatabaseReference:
				this.addDatabaseReferenceToProjFile(<DatabaseReferenceProjectEntry>entry);
		}

		await this.serializeToProjFile(this.projFileXmlDoc);
	}

	private async serializeToProjFile(projFileContents: any) {
		const xml = new xmldom.XMLSerializer().serializeToString(projFileContents); // TODO: how to get this to serialize with "pretty" formatting

		await fs.writeFile(this.projectFilePath, xml);
	}

	/**
	 * Adds the list of sql files and directories to the project, and saves the project file
	 * @param absolutePath Absolute path of the folder
	 */
	public async addToProject(list: string[]): Promise<void> {

		for (let i = 0; i < list.length; i++) {
			let file: string = list[i];
			const relativePath = utils.trimChars(utils.trimUri(Uri.file(this.projectFilePath), Uri.file(file)), '/');

			if (relativePath.length > 0) {
				let fileStat = await fs.stat(file);

				if (fileStat.isFile() && file.toLowerCase().endsWith(constants.sqlFileExtension)) {
					await this.addScriptItem(relativePath);
				}
				else if (fileStat.isDirectory()) {
					await this.addFolderItem(relativePath);
				}
			}
		}
	}
}

/**
 * Represents an entry in a project file
 */
export class ProjectEntry {
	/**
	 * Absolute file system URI
	 */
	fsUri: Uri;
	relativePath: string;
	type: EntryType;

	constructor(uri: Uri, relativePath: string, type: EntryType) {
		this.fsUri = uri;
		this.relativePath = relativePath;
		this.type = type;
	}

	public toString(): string {
		return this.fsUri.path;
	}
}

/**
 * Represents a database reference entry in a project file
 */
class DatabaseReferenceProjectEntry extends ProjectEntry {
	constructor(uri: Uri, public databaseLocation: DatabaseReferenceLocation, public name?: string) {
		super(uri, '', EntryType.DatabaseReference);
	}
}

export enum EntryType {
	File,
	Folder,
	DatabaseReference
}

export enum DatabaseReferenceLocation {
	sameDatabase,
	differentDatabaseSameServer
}

export enum TargetPlatform {
	Sql90 = '90',
	Sql100 = '100',
	Sql110 = '110',
	Sql120 = '120',
	Sql130 = '130',
	Sql140 = '140',
	Sql150 = '150',
	SqlAzureV12 = 'AzureV12'
}
