import * as vscode from 'vscode';
import * as path from 'path';
import { sql01MessageTypes } from './sql/01_message_types';
import { sql02Contracts } from './sql/02_contracts';
import { sql03QueueServiceActivation } from './sql/03_queue_service_activation';
import { sql04DispatchTables } from './sql/04_dispatch_tables';
import { sql05DispatchProcs } from './sql/05_dispatch_procs';
import { sql06ActivationProc } from './sql/06_activation_proc';

interface SqlFile {
    name: string;
    content: string;
}

export async function generateBaseline(
    workspaceRoot: string,
    generatedFolder: string,
    maxQueueReaders: number,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    const outDir = vscode.Uri.file(path.join(workspaceRoot, generatedFolder));
    await vscode.workspace.fs.createDirectory(outDir);

    const files: SqlFile[] = [
        { name: '01_message_types.sql', content: sql01MessageTypes() },
        { name: '02_contracts.sql', content: sql02Contracts() },
        { name: '03_queue_service_activation.sql', content: sql03QueueServiceActivation(maxQueueReaders) },
        { name: '04_dispatch_tables.sql', content: sql04DispatchTables() },
        { name: '05_dispatch_procs.sql', content: sql05DispatchProcs() },
        { name: '06_activation_proc.sql', content: sql06ActivationProc() },
    ];

    const encoder = new TextEncoder();

    for (const f of files) {
        const fileUri = vscode.Uri.file(path.join(workspaceRoot, generatedFolder, f.name));
        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(f.content));
        outputChannel.appendLine(`  Written: ${path.join(generatedFolder, f.name)}`);
    }
}
