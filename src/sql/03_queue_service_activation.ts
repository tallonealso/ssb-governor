export function sql03QueueServiceActivation(maxQueueReaders: number): string {
    return `-- =============================================================
-- 03_queue_service_activation.sql
-- Creates [SSB].[Q_Inbound], [SSB].[Svc_Inbound], and enables
-- activation.  MAX_QUEUE_READERS = ${maxQueueReaders} (configured via
-- ssbGovernor.maxQueueReaders).  Idempotent.
-- =============================================================

-- Queue
IF NOT EXISTS (
    SELECT 1 FROM sys.service_queues sq
    JOIN sys.schemas s ON s.schema_id = sq.schema_id
    WHERE s.name = N'SSB' AND sq.name = N'Q_Inbound'
)
BEGIN
    CREATE QUEUE [SSB].[Q_Inbound]
        WITH
            STATUS = ON,
            RETENTION = OFF,
            POISON_MESSAGE_HANDLING (STATUS = ON);
END
GO

-- Service
IF NOT EXISTS (
    SELECT 1 FROM sys.services sv
    WHERE sv.name = N'[SSB].[Svc_Inbound]'
)
BEGIN
    CREATE SERVICE [SSB].[Svc_Inbound]
        ON QUEUE [SSB].[Q_Inbound]
        (
            [SSB].[Ctr_FF],
            [SSB].[Ctr_LR]
        );
END
GO

-- Activation
ALTER QUEUE [SSB].[Q_Inbound]
    WITH ACTIVATION
    (
        STATUS          = ON,
        PROCEDURE_NAME  = [SSB].[usp_Activation_Inbound],
        MAX_QUEUE_READERS = ${maxQueueReaders},
        EXECUTE AS      OWNER
    );
GO
`;
}
