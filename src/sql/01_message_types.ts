export function sql01MessageTypes(): string {
    return `-- =============================================================
-- 01_message_types.sql
-- Creates all required Service Broker message types under [SSB].
-- Idempotent: skips creation if the type already exists.
-- =============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.service_message_types
    WHERE name = N'[SSB].[EndOfStream]'
)
BEGIN
    CREATE MESSAGE TYPE [SSB].[EndOfStream]
        VALIDATION = WELL_FORMED_XML;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.service_message_types
    WHERE name = N'[SSB].[FFSend]'
)
BEGIN
    CREATE MESSAGE TYPE [SSB].[FFSend]
        VALIDATION = WELL_FORMED_XML;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.service_message_types
    WHERE name = N'[SSB].[LRSend]'
)
BEGIN
    CREATE MESSAGE TYPE [SSB].[LRSend]
        VALIDATION = WELL_FORMED_XML;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.service_message_types
    WHERE name = N'[SSB].[LRAck]'
)
BEGIN
    CREATE MESSAGE TYPE [SSB].[LRAck]
        VALIDATION = WELL_FORMED_XML;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.service_message_types
    WHERE name = N'[SSB].[LRResponse]'
)
BEGIN
    CREATE MESSAGE TYPE [SSB].[LRResponse]
        VALIDATION = WELL_FORMED_XML;
END
GO
`;
}
