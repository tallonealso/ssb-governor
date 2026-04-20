import * as vscode from 'vscode';
import * as path from 'path';

export interface CheckResult {
    ruleId: string;
    description: string;
    pass: boolean;
    violations: ViolationDetail[];
}

export interface ViolationDetail {
    file: string;
    line: number;
    message: string;
}

export interface ValidationResult {
    totalViolations: number;
    diagnostics: Map<vscode.Uri, vscode.Diagnostic[]>;
    checks: CheckResult[];
}

// ─── Canonical expectations ────────────────────────────────────────────────

const REQUIRED_MESSAGE_TYPES = [
    '[SSB].[EndOfStream]',
    '[SSB].[FFSend]',
    '[SSB].[LRSend]',
    '[SSB].[LRAck]',
    '[SSB].[LRResponse]',
];

const CONTRACT_CTR_FF_MESSAGES = [
    { type: '[SSB].[FFSend]', sentBy: 'INITIATOR' },
    { type: '[SSB].[EndOfStream]', sentBy: 'INITIATOR' },
];

const CONTRACT_CTR_LR_MESSAGES = [
    { type: '[SSB].[LRSend]', sentBy: 'INITIATOR' },
    { type: '[SSB].[LRAck]', sentBy: 'TARGET' },
    { type: '[SSB].[LRResponse]', sentBy: 'TARGET' },
    { type: '[SSB].[EndOfStream]', sentBy: 'INITIATOR' },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Escapes all regex special characters (including backslash) in a literal string
 * so it can safely be embedded inside `new RegExp(...)`.
 */
function escapeRegex(s: string): string {
    return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Returns the 0-based line index of the first line matching the pattern.
 * Returns -1 if not found.
 */
function findLine(text: string, pattern: RegExp): number {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
            return i;
        }
    }
    return -1;
}

function normalizeSQL(sql: string): string {
    return sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toUpperCase();
}

function makeDiagnostic(line: number, message: string): vscode.Diagnostic {
    const lineNum = Math.max(0, line);
    const range = new vscode.Range(lineNum, 0, lineNum, 0);
    return new vscode.Diagnostic(range, `SSB Governor: ${message}`, vscode.DiagnosticSeverity.Error);
}

// ─── File reader ───────────────────────────────────────────────────────────

async function readSqlFiles(workspaceRoot: string, outputChannel: vscode.OutputChannel): Promise<Map<string, string>> {
    const files = await vscode.workspace.findFiles('ssb/**/*.sql', '**/generated/**');
    const result = new Map<string, string>();

    for (const uri of files) {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            result.set(uri.fsPath, new TextDecoder().decode(bytes));
            outputChannel.appendLine(`  Scanning: ${path.relative(workspaceRoot, uri.fsPath)}`);
        } catch (err) {
            outputChannel.appendLine(`  Warning: could not read ${uri.fsPath} – ${err}`);
        }
    }
    return result;
}

// ─── Individual rule checkers ──────────────────────────────────────────────

function checkMessageTypes(
    fileContents: Map<string, string>
): CheckResult {
    const violations: ViolationDetail[] = [];

    for (const msgType of REQUIRED_MESSAGE_TYPES) {
        let found = false;
        let foundValidation = false;

        for (const [filePath, raw] of fileContents) {
            const upper = normalizeSQL(raw);
            const escapedType = escapeRegex(msgType.toUpperCase());

            const createPattern = new RegExp(
                `CREATE\\s+MESSAGE\\s+TYPE\\s+${escapedType}`,
            );
            if (createPattern.test(upper)) {
                found = true;
                if (/VALIDATION\s*=\s*WELL_FORMED_XML/.test(upper)) {
                    foundValidation = true;
                }
                if (!foundValidation) {
                    const lineIdx = findLine(
                        raw,
                        new RegExp(`CREATE\\s+MESSAGE\\s+TYPE\\s+${escapeRegex(msgType)}`, 'i'),
                    );
                    violations.push({
                        file: filePath,
                        line: lineIdx >= 0 ? lineIdx : 0,
                        message: `Message type ${msgType} must have VALIDATION = WELL_FORMED_XML`,
                    });
                }
            }
        }

        if (!found) {
            violations.push({
                file: '',
                line: 0,
                message: `Required message type ${msgType} not found in any /ssb/**/*.sql file`,
            });
        }
    }

    return {
        ruleId: 'SSB-MT-001',
        description: 'All required message types exist with VALIDATION = WELL_FORMED_XML',
        pass: violations.length === 0,
        violations,
    };
}

function checkContracts(fileContents: Map<string, string>): CheckResult {
    const violations: ViolationDetail[] = [];

    function checkContract(
        contractName: string,
        expectedMessages: { type: string; sentBy: string }[],
    ): void {
        let contractBlock = '';
        let contractFile = '';
        let contractLine = 0;

        for (const [filePath, raw] of fileContents) {
            const upper = normalizeSQL(raw);
            const escapedName = escapeRegex(contractName.toUpperCase());
            const pattern = new RegExp(`CREATE\\s+CONTRACT\\s+${escapedName}`);
            if (pattern.test(upper)) {
                contractBlock = upper;
                contractFile = filePath;
                contractLine = findLine(
                    raw,
                    new RegExp(`CREATE\\s+CONTRACT`, 'i'),
                );
                break;
            }
        }

        if (!contractBlock) {
            violations.push({
                file: '',
                line: 0,
                message: `Contract ${contractName} not found in any /ssb/**/*.sql file`,
            });
            return;
        }

        for (const { type, sentBy } of expectedMessages) {
            const escapedType = escapeRegex(type.toUpperCase());
            const msgPattern = new RegExp(
                `${escapedType}\\s+SENT\\s+BY\\s+${sentBy.toUpperCase()}`,
            );
            if (!msgPattern.test(contractBlock)) {
                violations.push({
                    file: contractFile,
                    line: contractLine >= 0 ? contractLine : 0,
                    message: `Contract ${contractName} is missing: ${type} SENT BY ${sentBy}`,
                });
            }
        }
    }

    checkContract('[SSB].[Ctr_FF]', CONTRACT_CTR_FF_MESSAGES);
    checkContract('[SSB].[Ctr_LR]', CONTRACT_CTR_LR_MESSAGES);

    return {
        ruleId: 'SSB-CT-001',
        description: 'Contracts Ctr_FF and Ctr_LR exist with correct message directions',
        pass: violations.length === 0,
        violations,
    };
}

function checkQueueServiceActivation(fileContents: Map<string, string>): CheckResult {
    const violations: ViolationDetail[] = [];

    let foundQueue = false;
    let foundService = false;
    let foundActivation = false;

    for (const [filePath, raw] of fileContents) {
        const upper = normalizeSQL(raw);

        // Queue check
        if (/CREATE\s+QUEUE\s+\[SSB\]\.\[Q_INBOUND\]/.test(upper)) {
            foundQueue = true;
            const lineIdx = findLine(raw, /CREATE\s+QUEUE/i);
            if (!/STATUS\s*=\s*ON/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Queue [SSB].[Q_Inbound] must have STATUS = ON' });
            }
            if (!/RETENTION\s*=\s*OFF/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Queue [SSB].[Q_Inbound] must have RETENTION = OFF' });
            }
            if (!/POISON_MESSAGE_HANDLING\s*\(\s*STATUS\s*=\s*ON/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Queue [SSB].[Q_Inbound] must have POISON_MESSAGE_HANDLING (STATUS = ON)' });
            }
        }

        // Service check
        if (/CREATE\s+SERVICE\s+\[SSB\]\.\[SVC_INBOUND\]/.test(upper)) {
            foundService = true;
            const lineIdx = findLine(raw, /CREATE\s+SERVICE/i);
            if (!/\[SSB\]\.\[CTR_FF\]/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Service [SSB].[Svc_Inbound] must list contract [SSB].[Ctr_FF]' });
            }
            if (!/\[SSB\]\.\[CTR_LR\]/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Service [SSB].[Svc_Inbound] must list contract [SSB].[Ctr_LR]' });
            }
        }

        // Activation check (ALTER QUEUE or CREATE QUEUE WITH ACTIVATION)
        if (/ALTER\s+QUEUE\s+\[SSB\]\.\[Q_INBOUND\]/.test(upper) || (/CREATE\s+QUEUE\s+\[SSB\]\.\[Q_INBOUND\]/.test(upper) && /ACTIVATION/.test(upper))) {
            const lineIdx = findLine(raw, /ACTIVATION/i);
            if (/ACTIVATION/.test(upper)) {
                foundActivation = true;
                if (!/PROCEDURE_NAME\s*=\s*\[SSB\]\.\[USP_ACTIVATION_INBOUND\]/.test(upper)) {
                    violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Activation PROCEDURE_NAME must be [SSB].[usp_Activation_Inbound]' });
                }
                if (!/EXECUTE\s+AS\s+OWNER/.test(upper)) {
                    violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Activation must use EXECUTE AS OWNER' });
                }
                if (!/STATUS\s*=\s*ON/.test(upper)) {
                    violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: 'Activation STATUS must be ON' });
                }
            }
        }
    }

    if (!foundQueue) {
        violations.push({ file: '', line: 0, message: 'Queue [SSB].[Q_Inbound] not found in any /ssb/**/*.sql file' });
    }
    if (!foundService) {
        violations.push({ file: '', line: 0, message: 'Service [SSB].[Svc_Inbound] not found in any /ssb/**/*.sql file' });
    }
    if (!foundActivation) {
        violations.push({ file: '', line: 0, message: 'Activation for [SSB].[Q_Inbound] not found in any /ssb/**/*.sql file' });
    }

    return {
        ruleId: 'SSB-QSA-001',
        description: 'Queue, Service, and Activation objects exist with correct settings',
        pass: violations.length === 0,
        violations,
    };
}

function checkDispatchTables(fileContents: Map<string, string>): CheckResult {
    const violations: ViolationDetail[] = [];

    let foundDispatchQueue = false;
    let foundDeadLetter = false;
    let foundErrorLog = false;
    let foundStreamCloseLog = false;

    for (const [filePath, raw] of fileContents) {
        const upper = normalizeSQL(raw);

        if (/CREATE\s+TABLE\s+\[SSB\]\.\[DISPATCHQUEUE\]/i.test(upper)) {
            foundDispatchQueue = true;
            const lineIdx = findLine(raw, /CREATE\s+TABLE\s+\[SSB\]\.\[DispatchQueue\]/i);
            if (!/NEWSEQUENTIALID\(\)/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: '[SSB].[DispatchQueue] PK must use NEWSEQUENTIALID()' });
            }
            if (!/PRIORITYCLASS\s+TINYINT/i.test(upper)) {
                violations.push({ file: filePath, line: lineIdx >= 0 ? lineIdx : 0, message: '[SSB].[DispatchQueue] must have PriorityClass tinyint column' });
            }
        }

        if (/CREATE\s+TABLE\s+\[SSB\]\.\[DISPATCHDEADLETTER\]/i.test(upper)) {
            foundDeadLetter = true;
        }

        if (/CREATE\s+TABLE\s+\[SSB\]\.\[ACTIVATIONERRORLOG\]/i.test(upper)) {
            foundErrorLog = true;
        }

        if (/CREATE\s+TABLE\s+\[SSB\]\.\[STREAMCLOSELOG\]/i.test(upper)) {
            foundStreamCloseLog = true;
        }
    }

    if (!foundDispatchQueue) {
        violations.push({ file: '', line: 0, message: 'Table [SSB].[DispatchQueue] not found' });
    }
    if (!foundDeadLetter) {
        violations.push({ file: '', line: 0, message: 'Table [SSB].[DispatchDeadLetter] not found' });
    }
    if (!foundErrorLog) {
        violations.push({ file: '', line: 0, message: 'Table [SSB].[ActivationErrorLog] not found' });
    }
    if (!foundStreamCloseLog) {
        violations.push({ file: '', line: 0, message: 'Table [SSB].[StreamCloseLog] not found' });
    }

    return {
        ruleId: 'SSB-DT-001',
        description: 'Dispatch and support tables exist with correct structure',
        pass: violations.length === 0,
        violations,
    };
}

function checkDispatchProcs(fileContents: Map<string, string>): CheckResult {
    const violations: ViolationDetail[] = [];

    const required = [
        '[SSB].[usp_Dispatch_ClaimNext]',
        '[SSB].[usp_Dispatch_Complete]',
        '[SSB].[usp_Dispatch_FailAndSchedule]',
        '[SSB].[usp_Activation_Inbound]',
    ];

    for (const proc of required) {
        let found = false;
        const escapedUpper = escapeRegex(proc.toUpperCase());
        for (const [, raw] of fileContents) {
            const upper = normalizeSQL(raw);
            if (
                new RegExp(`CREATE\\s+(OR\\s+ALTER\\s+)?PROCEDURE\\s+${escapedUpper}`).test(upper) ||
                new RegExp(`ALTER\\s+PROCEDURE\\s+${escapedUpper}`).test(upper)
            ) {
                found = true;
                break;
            }
        }
        if (!found) {
            violations.push({ file: '', line: 0, message: `Stored procedure ${proc} not found in any /ssb/**/*.sql file` });
        }
    }

    // Check activation proc for key patterns
    for (const [filePath, raw] of fileContents) {
        const upper = normalizeSQL(raw);
        if (/USP_ACTIVATION_INBOUND/.test(upper)) {
            const lineIdx = 0;
            if (!/RECEIVE\s+TOP/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx, message: '[SSB].[usp_Activation_Inbound] must use RECEIVE TOP to read from the queue' });
            }
            if (!/END\s+CONVERSATION/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx, message: '[SSB].[usp_Activation_Inbound] must call END CONVERSATION' });
            }
            if (!/BEGIN\s+CATCH/.test(upper)) {
                violations.push({ file: filePath, line: lineIdx, message: '[SSB].[usp_Activation_Inbound] must have a CATCH block to prevent poison-message disable' });
            }
        }
    }

    return {
        ruleId: 'SSB-SP-001',
        description: 'Required stored procedures exist with correct patterns',
        pass: violations.length === 0,
        violations,
    };
}

function checkSchemaQualification(fileContents: Map<string, string>): CheckResult {
    const violations: ViolationDetail[] = [];

    const patterns = [
        /\bCREATE\s+MESSAGE\s+TYPE\s+(?!\[SSB\])/i,
        /\bCREATE\s+CONTRACT\s+(?!\[SSB\])/i,
        /\bCREATE\s+QUEUE\s+(?!\[SSB\])/i,
        /\bCREATE\s+SERVICE\s+(?!\[SSB\])/i,
    ];

    for (const [filePath, raw] of fileContents) {
        const lines = raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pattern of patterns) {
                if (pattern.test(line) && !/--/.test(line.substring(0, line.search(pattern)))) {
                    violations.push({
                        file: filePath,
                        line: i,
                        message: `SSB object must be schema-qualified with [SSB]: ${line.trim()}`,
                    });
                }
            }
        }
    }

    return {
        ruleId: 'SSB-SCH-001',
        description: 'All SSB objects must be schema-qualified as [SSB].[...]',
        pass: violations.length === 0,
        violations,
    };
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function validateWorkspace(
    workspaceRoot: string,
    outputChannel: vscode.OutputChannel,
): Promise<ValidationResult> {
    outputChannel.appendLine('Scanning /ssb/**/*.sql (excluding /ssb/generated/)...');

    const fileContents = await readSqlFiles(workspaceRoot, outputChannel);

    if (fileContents.size === 0) {
        outputChannel.appendLine('No .sql files found under /ssb/ (excluding generated).');
    }

    outputChannel.appendLine('');
    outputChannel.appendLine('Running checks...');

    const checks: CheckResult[] = [
        checkMessageTypes(fileContents),
        checkContracts(fileContents),
        checkQueueServiceActivation(fileContents),
        checkDispatchTables(fileContents),
        checkDispatchProcs(fileContents),
        checkSchemaQualification(fileContents),
    ];

    const diagnosticsMap = new Map<vscode.Uri, vscode.Diagnostic[]>();
    let totalViolations = 0;

    for (const check of checks) {
        const icon = check.pass ? '✔' : '✘';
        outputChannel.appendLine(`  [${icon}] ${check.ruleId}: ${check.description}`);

        for (const v of check.violations) {
            totalViolations++;
            outputChannel.appendLine(`       • ${v.file ? path.relative(workspaceRoot, v.file) + ':' + (v.line + 1) : '(no file)'} – ${v.message}`);

            if (v.file) {
                const uri = vscode.Uri.file(v.file);
                if (!diagnosticsMap.has(uri)) {
                    diagnosticsMap.set(uri, []);
                }
                diagnosticsMap.get(uri)!.push(makeDiagnostic(v.line, v.message));
            }
        }
    }

    return { totalViolations, diagnostics: diagnosticsMap, checks };
}
