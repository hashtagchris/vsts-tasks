import path = require('path');
import tl = require('vsts-task-lib/task');
import sign = require('ios-signing-common/ios-signing-common');
import utils = require('./xcodeutils');

import { ToolRunner } from 'vsts-task-lib/toolrunner';

async function run() {
    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));

        //--------------------------------------------------------
        // Tooling
        //--------------------------------------------------------

        let xcodeVersionSelection: string = tl.getInput('xcodeVersion', true);

        if (xcodeVersionSelection === 'specifyPath') {
            let devDir = tl.getInput('xcodeDeveloperDir', true);
            tl.setVariable('DEVELOPER_DIR', devDir);
        }
        else if (xcodeVersionSelection !== 'default') {
            // resolve the developer dir for a version like "8" or "9".
            let devDir = utils.findDeveloperDir(xcodeVersionSelection);
            tl.setVariable('DEVELOPER_DIR', devDir);
        }

        let tool: string = tl.which('xcodebuild', true);
        tl.debug('Tool selected: ' + tool);

        //--------------------------------------------------------
        // Paths
        //--------------------------------------------------------
        let workingDir: string = tl.getPathInput('cwd');
        tl.cd(workingDir);

        let outPath: string = tl.resolve(workingDir, tl.getInput('outputPattern', true)); //use posix implementation to resolve paths to prevent unit test failures on Windows
        tl.mkdirP(outPath);

        //--------------------------------------------------------
        // Xcode args
        //--------------------------------------------------------
        let wsOrProj: string = tl.getPathInput('xcWorkspacePath', false, false);
        let workspace: string;
        let project: string;
        if (tl.filePathSupplied('xcWorkspacePath')) {
            let workspaceMatches = tl.findMatch(workingDir, wsOrProj, { followSymbolicLinks: false, followSpecifiedSymbolicLink: false });
            tl.debug("Found " + workspaceMatches.length + ' workspaces matching.');

            if (workspaceMatches.length > 0) {
                wsOrProj = workspaceMatches[0];
                if (workspaceMatches.length > 1) {
                    tl.warning(tl.loc('MultipleWorkspacesFound', wsOrProj));
                }
            }
            else {
                throw tl.loc('WorkspaceDoesNotExist', wsOrProj);
            }

            if (wsOrProj.trim().toLowerCase().endsWith('.xcodeproj')) {
                project = wsOrProj;
            }
            else {
                workspace = wsOrProj;
            }
        }

        if (workspace) {
            if ((tl.getVariable('disableWSS') || '').toUpperCase() != "TRUE") {
                // Configure intermediates and artifacts to be built under the output directory.
                // TODO: Will this technique work only with the new build system?
                let whoami: string = tl.which('whoami', true);
                let username: string = tl.tool(whoami).execSync().stdout.trim();

                if (!username) {
                    // TODO: loc
                    // TODO: tests
                    throw 'Unable to determine current username.';
                }

                let plist: string = tl.which('/usr/libexec/PlistBuddy', true);

                let userSettingsDir: string = tl.resolve(`${workspace}/xcuserdata/${username}.xcuserdatad`);
                tl.mkdirP(userSettingsDir);
                let workspaceSettings = tl.resolve(userSettingsDir, 'WorkspaceSettings.xcsettings');

                tl.tool(plist).arg(['-c', 'Clear', workspaceSettings]).execSync();
                tl.tool(plist).arg(['-c', 'Add DerivedDataLocationStyle string AbsolutePath', workspaceSettings]).execSync();
                tl.tool(plist).arg(['-c', `Add DerivedDataCustomLocation string ${outPath}`, workspaceSettings]).execSync();
            }
            else {
                tl.debug('Skipping creation of WorkspaceSettings.xcsettings');
            }
        }

        let scheme: string = tl.getInput('scheme', false);

        // If we have a workspace argument but no scheme, see if there's
        // single shared scheme we can use.
        if (!scheme && workspace) {
            try {
                let schemes: string[] = await utils.getWorkspaceSchemes(tool, workspace);

                if (schemes.length > 1) {
                    tl.warning(tl.loc('MultipleSchemesFound'));
                }
                else if (schemes.length === 0) {
                    tl.warning(tl.loc('NoSchemeFound'));
                }
                else {
                    scheme = schemes[0];
                    console.log(tl.loc('SchemeSelected', scheme));
                }
            }
            catch (err) {
                tl.warning(tl.loc('FailedToFindScheme'));
            }
        }

        let destinations: string[];

        // To be yaml friendly, we'll let you skip destinationPlatformOption and supply destinationPlatform, custom or not.
        let platform: string = tl.getInput('destinationPlatform', false) || tl.getInput('destinationPlatformOption', false);
        if (platform === 'macOS') {
            destinations = ['platform=macOS'];
        }
        else if (platform && platform !== 'default') {
            // To be yaml friendly, destinationTypeOption is optional and we default to simulators.
            let destinationType: string = tl.getInput('destinationTypeOption', false);
            let targetingSimulators: boolean = destinationType !== 'devices';

            let devices: string[];
            if (targetingSimulators) {
                // Only one simulator for now.
                devices = [ tl.getInput('destinationSimulators') ];
            }
            else {
                // Only one device for now.
                devices = [ tl.getInput('destinationDevices') ];
            }

            destinations = utils.buildDestinationArgs(platform, devices, targetingSimulators);
        }

        let sdk: string = tl.getInput('sdk', false);
        let configuration: string = tl.getInput('configuration', false);
        let useXcpretty: boolean = tl.getBoolInput('useXcpretty', false);
        let actions: string[] = tl.getDelimitedInput('actions', ' ', true);
        let packageApp: boolean = tl.getBoolInput('packageApp', true);
        let args: string = tl.getInput('args', false);

        //--------------------------------------------------------
        // Exec Tools
        //--------------------------------------------------------

        // --- Xcode Version ---
        let xcv: ToolRunner = tl.tool(tool);
        xcv.arg('-version');
        let xcodeVersion: number = 0;
        xcv.on('stdout', (data) => {
            let match = data.toString().trim().match(/Xcode (.+)/g);
            tl.debug('match = ' + match);
            if (match) {
                let version: number = parseInt(match.toString().replace('Xcode', '').trim());
                tl.debug('version = ' + version);
                if (!isNaN(version)) {
                    xcodeVersion = version;
                }
            }
        });

        await xcv.exec();
        tl.debug('xcodeVersion = ' + xcodeVersion);

        // --- Xcode build arguments ---
        let xcb: ToolRunner = tl.tool(tool);
        xcb.argIf(sdk, ['-sdk', sdk]);
        xcb.argIf(configuration, ['-configuration', configuration]);
        xcb.argIf(project, ['-project', project]);
        xcb.argIf(workspace, ['-workspace', workspace]);
        xcb.argIf(scheme, ['-scheme', scheme]);
        // Add a -destination argument for each device and simulator.
        if (destinations) {
            destinations.forEach(destination => {
                xcb.arg(['-destination', destination]);
            });
        }
        xcb.arg(actions);
        if (args) {
            xcb.line(args);
        }

        //--------------------------------------------------------
        // iOS signing and provisioning
        //--------------------------------------------------------
        let signingOption: string = tl.getInput('signingOption', true);
        let keychainToDelete: string;
        let profileToDelete: string;
        let xcode_codeSigningAllowed: string;
        let xcode_codeSignStyle: string;
        let xcode_otherCodeSignFlags: string;
        let xcode_codeSignIdentity: string;
        let xcode_provProfile: string;
        let xcode_devTeam: string;

        if (signingOption === 'nosign') {
            xcode_codeSigningAllowed = 'CODE_SIGNING_ALLOWED=NO';
        }
        else if (signingOption === 'manual') {
            xcode_codeSignStyle = 'CODE_SIGN_STYLE=Manual';

            let signIdentity: string = tl.getInput('signingIdentity');
            if (signIdentity) {
                xcode_codeSignIdentity = 'CODE_SIGN_IDENTITY=' + signIdentity;
            }

            let provProfileUUID: string = tl.getInput('provisioningProfileUuid');
            if (provProfileUUID) {
                xcode_provProfile = 'PROVISIONING_PROFILE=' + provProfileUUID;
            }
        }
        else if (signingOption === 'auto') {
            xcode_codeSignStyle = 'CODE_SIGN_STYLE=Automatic';

            let teamId: string = tl.getInput('teamId');
            if (teamId) {
                xcode_devTeam = 'DEVELOPMENT_TEAM=' + teamId;
            }
        }

        xcb.argIf(xcode_codeSigningAllowed, xcode_codeSigningAllowed);
        xcb.argIf(xcode_codeSignStyle, xcode_codeSignStyle);
        xcb.argIf(xcode_codeSignIdentity, xcode_codeSignIdentity);
        xcb.argIf(xcode_provProfile, xcode_provProfile);
        xcb.argIf(xcode_devTeam, xcode_devTeam);

        //--- Enable Xcpretty formatting if using xcodebuild ---
        if (useXcpretty) {
            let xcPrettyPath: string = tl.which('xcpretty', true);
            let xcPrettyTool: ToolRunner = tl.tool(xcPrettyPath);
            xcPrettyTool.arg(['-r', 'junit', '--no-color']);

            xcb.pipeExecOutputToTool(xcPrettyTool);
        }

        //--- Xcode Build ---
        await xcb.exec();

        try {
            tl.tool('/bin/ls').arg(['-la', `${outPath}/Xcode833AutomaticSigning-adokilxvmctjblcchhjivwkrgfzq/Build/Intermediates/ArchiveIntermediates/Xcode833AutomaticSigning/BuildProductsPath/Release-iphoneos`]).execSync();
        }
        catch (err) {}

        try {
            tl.tool('/bin/ls').arg(['-la', `${outPath}/Xcode833AutomaticSigning-adokilxvmctjblcchhjivwkrgfzq/Build/Intermediates/ArchiveIntermediates/Xcode833AutomaticSigning/InstallationBuildProductsLocation/Applications`]).execSync();
        }
        catch (err) {}

        //--------------------------------------------------------
        // Test publishing
        //--------------------------------------------------------
        let testResultsFiles: string;
        let publishResults: boolean = tl.getBoolInput('publishJUnitResults', false);

        if (publishResults) {
            if (!useXcpretty) {
                tl.warning(tl.loc('UseXcprettyForTestPublishing'));
            } else {
                testResultsFiles = tl.resolve(workingDir, '**/build/reports/junit.xml');
            }

            if (testResultsFiles && 0 !== testResultsFiles.length) {
                //check for pattern in testResultsFiles

                let matchingTestResultsFiles: string[];
                if (testResultsFiles.indexOf('*') >= 0 || testResultsFiles.indexOf('?') >= 0) {
                    tl.debug('Pattern found in testResultsFiles parameter');
                    matchingTestResultsFiles = tl.findMatch(workingDir, testResultsFiles, { followSymbolicLinks: false, followSpecifiedSymbolicLink: false }, { matchBase: true });
                }
                else {
                    tl.debug('No pattern found in testResultsFiles parameter');
                    matchingTestResultsFiles = [testResultsFiles];
                }

                if (!matchingTestResultsFiles) {
                    tl.warning(tl.loc('NoTestResultsFound', testResultsFiles));
                }

                let tp = new tl.TestPublisher("JUnit");
                tp.publish(matchingTestResultsFiles, false, "", "", "", true);
            }
        }

        //--------------------------------------------------------
        // Package app to generate .ipa
        //--------------------------------------------------------
        if (tl.getBoolInput('packageApp', true) && sdk !== 'iphonesimulator') {
            // use xcodebuild to create the app package
            if (!scheme) {
                throw tl.loc("SchemeRequiredForArchive");
            }
            if (!project && !workspace) {
                throw tl.loc("WorkspaceOrProjectRequiredForArchive");
            }

            // create archive
            let xcodeArchive: ToolRunner = tl.tool(tl.which('xcodebuild', true));
            xcodeArchive.argIf(project, ['-project', project]);
            xcodeArchive.argIf(workspace, ['-workspace', workspace]);
            xcodeArchive.argIf(scheme, ['-scheme', scheme]);
            xcodeArchive.arg('archive'); //archive action
            xcodeArchive.argIf(sdk, ['-sdk', sdk]);
            xcodeArchive.argIf(configuration, ['-configuration', configuration]);
            let archivePath: string = tl.getInput('archivePath');
            let archiveFolderRoot: string;
            if (!archivePath.endsWith('.xcarchive')) {
                archiveFolderRoot = archivePath;
                archivePath = tl.resolve(archivePath, scheme);
            } else {
                //user specified a file path for archivePath
                archiveFolderRoot = path.dirname(archivePath);
            }
            xcodeArchive.arg(['-archivePath', archivePath]);
            xcodeArchive.argIf(xcode_otherCodeSignFlags, xcode_otherCodeSignFlags);
            xcodeArchive.argIf(xcode_codeSigningAllowed, xcode_codeSigningAllowed);
            xcodeArchive.argIf(xcode_codeSignStyle, xcode_codeSignStyle);
            xcodeArchive.argIf(xcode_codeSignIdentity, xcode_codeSignIdentity);
            xcodeArchive.argIf(xcode_provProfile, xcode_provProfile);
            xcodeArchive.argIf(xcode_devTeam, xcode_devTeam);
            if (args) {
                xcodeArchive.line(args);
            }

            if (useXcpretty) {
                let xcPrettyTool: ToolRunner = tl.tool(tl.which('xcpretty', true));
                xcPrettyTool.arg('--no-color');
                xcodeArchive.pipeExecOutputToTool(xcPrettyTool);
            }
            await xcodeArchive.exec();

            try {
                tl.tool('/bin/ls').arg(['-la', `${outPath}/Xcode833AutomaticSigning-adokilxvmctjblcchhjivwkrgfzq/Build/Intermediates/ArchiveIntermediates/Xcode833AutomaticSigning/BuildProductsPath/Release-iphoneos`]).execSync();
            }
            catch (err) {}

            try {
                tl.tool('/bin/ls').arg(['-la', `${outPath}/Xcode833AutomaticSigning-adokilxvmctjblcchhjivwkrgfzq/Build/Intermediates/ArchiveIntermediates/Xcode833AutomaticSigning/InstallationBuildProductsLocation/Applications`]).execSync();
            }
            catch (err) {}

            let archiveFolders: string[] = tl.findMatch(archiveFolderRoot, '**/*.xcarchive', { followSymbolicLinks: false, followSpecifiedSymbolicLink: false });
            if (archiveFolders && archiveFolders.length > 0) {
                tl.debug(archiveFolders.length + ' archives found for exporting.');

                //export options plist
                let exportOptions: string = tl.getInput('exportOptions');
                let exportMethod: string;
                let exportTeamId: string;
                let exportOptionsPlist: string;
                let archiveToCheck: string = archiveFolders[0];
                let embeddedProvProfiles: string[] = tl.findMatch(archiveToCheck, '**/embedded.mobileprovision', { followSymbolicLinks: false, followSpecifiedSymbolicLink: false });

                if (exportOptions === 'auto') {
                    // Automatically try to detect the export-method to use from the provisioning profile
                    // embedded in the .xcarchive file
                    if (embeddedProvProfiles && embeddedProvProfiles.length > 0) {
                        tl.debug('embedded prov profile = ' + embeddedProvProfiles[0]);
                        exportMethod = await sign.getProvisioningProfileType(embeddedProvProfiles[0]);
                        tl.debug('Using export method = ' + exportMethod);
                    }
                    if (!exportMethod) {
                        tl.warning(tl.loc('ExportMethodNotIdentified'));
                    }
                } else if (exportOptions === 'specify') {
                    exportMethod = tl.getInput('exportMethod', true);
                    exportTeamId = tl.getInput('exportTeamId');
                } else if (exportOptions === 'plist') {
                    exportOptionsPlist = tl.getInput('exportOptionsPlist');
                    if (!tl.filePathSupplied('exportOptionsPlist') || !utils.pathExistsAsFile(exportOptionsPlist)) {
                        throw tl.loc('ExportOptionsPlistInvalidFilePath', exportOptionsPlist);
                    }
                }

                if (exportMethod) {
                    // generate the plist file if we have an exportMethod set from exportOptions = auto or specify
                    let plist: string = tl.which('/usr/libexec/PlistBuddy', true);
                    exportOptionsPlist = '_XcodeTaskExportOptions.plist';
                    tl.tool(plist).arg(['-c', 'Clear', exportOptionsPlist]).execSync();
                    tl.tool(plist).arg(['-c', 'Add method string ' + exportMethod, exportOptionsPlist]).execSync();
                    if (exportTeamId) {
                        tl.tool(plist).arg(['-c', 'Add teamID string ' + exportTeamId, exportOptionsPlist]).execSync();
                    }

                    if (xcodeVersion >= 9 && exportOptions === 'auto') {
                        let signingOptionForExport = signingOption;

                        // If we're using the project defaults, scan the pbxProject file for the type of signing being used.
                        if (signingOptionForExport === 'default') {
                            signingOptionForExport = await utils.getProvisioningStyle(workspace);

                            if (!signingOptionForExport) {
                                tl.warning(tl.loc('CantDetermineProvisioningStyle'));
                            }
                        }

                        if (signingOptionForExport === 'manual') {
                            // Xcode 9 manual signing, set code sign style = manual
                            tl.tool(plist).arg(['-c', 'Add signingStyle string ' + 'manual', exportOptionsPlist]).execSync();

                            // add provisioning profiles to the exportOptions plist
                            // find bundle Id from Info.plist and prov profile name from the embedded profile in each .app package
                            tl.tool(plist).arg(['-c', 'Add provisioningProfiles dict', exportOptionsPlist]).execSync();

                            for (let i = 0; i < embeddedProvProfiles.length; i++) {
                                let embeddedProvProfile: string = embeddedProvProfiles[i];
                                let profileName: string = await sign.getProvisioningProfileName(embeddedProvProfile);
                                tl.debug('embedded provisioning profile = ' + embeddedProvProfile + ', profile name = ' + profileName);

                                let embeddedInfoPlist: string = tl.resolve(path.dirname(embeddedProvProfile), 'Info.plist');
                                let bundleId: string = await sign.getBundleIdFromPlist(embeddedInfoPlist);
                                tl.debug('embeddedInfoPlist path = ' + embeddedInfoPlist + ', bundle identifier = ' + bundleId);

                                if (!profileName || !bundleId) {
                                    throw tl.loc('FailedToGenerateExportOptionsPlist');
                                }

                                tl.tool(plist).arg(['-c', 'Add provisioningProfiles:' + bundleId + ' string ' + profileName, exportOptionsPlist]).execSync();
                            }
                        }
                    }
                }

                //export path
                let exportPath: string = tl.getInput('exportPath');
                if (!exportPath.endsWith('.ipa')) {
                    exportPath = tl.resolve(exportPath, '_XcodeTaskExport_' + scheme);
                }
                // delete if it already exists, otherwise export will fail
                if (tl.exist(exportPath)) {
                    tl.rmRF(exportPath);
                }

                for (var i = 0; i < archiveFolders.length; i++) {
                    let archive: string = archiveFolders.pop();

                    //export the archive
                    let xcodeExport: ToolRunner = tl.tool(tl.which('xcodebuild', true));
                    xcodeExport.arg(['-exportArchive', '-archivePath', archive]);
                    xcodeExport.arg(['-exportPath', exportPath]);
                    xcodeExport.argIf(exportOptionsPlist, ['-exportOptionsPlist', exportOptionsPlist]);
                    let exportArgs: string = tl.getInput('exportArgs');
                    xcodeExport.argIf(exportArgs, exportArgs);

                    if (useXcpretty) {
                        let xcPrettyTool: ToolRunner = tl.tool(tl.which('xcpretty', true));
                        xcPrettyTool.arg('--no-color');
                        xcodeExport.pipeExecOutputToTool(xcPrettyTool);
                    }
                    await xcodeExport.exec();

                    try {
                        tl.tool('/bin/ls').arg(['-la', `${outPath}/Xcode833AutomaticSigning-adokilxvmctjblcchhjivwkrgfzq/Build/Intermediates/ArchiveIntermediates/Xcode833AutomaticSigning/BuildProductsPath/Release-iphoneos`]).execSync();
                    }
                    catch (err) {}

                    try {
                        tl.tool('/bin/ls').arg(['-la', `${outPath}/Xcode833AutomaticSigning-adokilxvmctjblcchhjivwkrgfzq/Build/Intermediates/ArchiveIntermediates/Xcode833AutomaticSigning/InstallationBuildProductsLocation/Applications`]).execSync();
                    }
                    catch (err) {}
                }
            }
        }
        tl.setResult(tl.TaskResult.Succeeded, tl.loc('XcodeSuccess'));
    }
    catch (err) {
        tl.setResult(tl.TaskResult.Failed, err);
    }
}

run();
