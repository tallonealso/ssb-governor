import * as vscode from 'vscode';
import * as path from 'path';
import { validateWorkspace, ValidationResult } from './validator';
import { generateBaseline } from './generator';

let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('SSB Governor');
    diagnosticCollection = vscode.languages.createDiagnosticCollection('ssb-governor');

    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(outputChannel);

    context.subscriptions.push(
        vscode.commands.registerCommand('ssbGovernor.validate', () => runValidate())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ssbGovernor.generateBaseline', () => runGenerateBaseline())
    );
}

async function runValidate(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('SSB Governor: No workspace folder open.');
        return;
    }

    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine('SSB Governor – Validate  ' + new Date().toISOString());
    outputChannel.appendLine('');

    const config = vscode.workspace.getConfiguration('ssbGovernor');
    const reportsFolder = config.get<string>('reportsFolder', 'ssb/reports');

    const result = await validateWorkspace(workspaceRoot, outputChannel);

    diagnosticCollection.clear();
    for (const [fileUri, diags] of result.diagnostics) {
        diagnosticCollection.set(fileUri, diags);
    }

    outputChannel.appendLine('');
    outputChannel.appendLine(`Validation complete. Violations: ${result.totalViolations}`);

    await writeReport(workspaceRoot, reportsFolder, result);
}

async function runGenerateBaseline(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('SSB Governor: No workspace folder open.');
        return;
    }

    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine('SSB Governor – Generate Baseline  ' + new Date().toISOString());

    const config = vscode.workspace.getConfiguration('ssbGovernor');
    const generatedFolder = config.get<string>('generatedFolder', 'ssb/generated');
    const maxQueueReaders = config.get<number>('maxQueueReaders', 5);

    await generateBaseline(workspaceRoot, generatedFolder, maxQueueReaders, outputChannel);

    outputChannel.appendLine('');
    outputChannel.appendLine('Baseline generation complete.');
    vscode.window.showInformationMessage('SSB Governor: Baseline scripts generated under /' + generatedFolder + '/');
}

async function writeReport(workspaceRoot: string, reportsFolder: string, result: ValidationResult): Promise<void> {
    try {
        const reportDir = vscode.Uri.file(path.join(workspaceRoot, reportsFolder));
        await vscode.workspace.fs.createDirectory(reportDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const reportFile = vscode.Uri.file(path.join(workspaceRoot, reportsFolder, `validate-${timestamp}.json`));

        const report = {
            generatedAt: new Date().toISOString(),
            totalViolations: result.totalViolations,
            checks: result.checks,
        };

        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(reportFile, encoder.encode(JSON.stringify(report, null, 2)));
        outputChannel.appendLine(`Report written to ${reportFile.fsPath}`);
    } catch (err) {
        outputChannel.appendLine(`Warning: could not write report – ${err}`);
    }
}

function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0].uri.fsPath;
}

export function deactivate(): void {
    // nothing to clean up
}
