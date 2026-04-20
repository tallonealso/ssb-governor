export function sql02Contracts(): string {
    return `-- =============================================================
-- 02_contracts.sql
-- Creates Service Broker contracts [SSB].[Ctr_FF] and
-- [SSB].[Ctr_LR]. Idempotent.
-- =============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.service_contracts
    WHERE name = N'[SSB].[Ctr_FF]'
)
BEGIN
    CREATE CONTRACT [SSB].[Ctr_FF]
    (
        [SSB].[FFSend]      SENT BY INITIATOR,
        [SSB].[EndOfStream] SENT BY INITIATOR
    );
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.service_contracts
    WHERE name = N'[SSB].[Ctr_LR]'
)
BEGIN
    CREATE CONTRACT [SSB].[Ctr_LR]
    (
        [SSB].[LRSend]      SENT BY INITIATOR,
        [SSB].[LRAck]       SENT BY TARGET,
        [SSB].[LRResponse]  SENT BY TARGET,
        [SSB].[EndOfStream] SENT BY INITIATOR
    );
END
GO
`;
}
