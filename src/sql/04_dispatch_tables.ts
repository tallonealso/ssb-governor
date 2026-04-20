export function sql04DispatchTables(): string {
    return `-- =============================================================
-- 04_dispatch_tables.sql
-- Creates dispatcher and supporting tables under [SSB].
-- Idempotent.
-- =============================================================

-- Ensure schema exists
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'SSB')
BEGIN
    EXEC('CREATE SCHEMA [SSB]');
END
GO

-- DispatchQueue
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = N'SSB' AND t.name = N'DispatchQueue'
)
BEGIN
    CREATE TABLE [SSB].[DispatchQueue]
    (
        DispatchId          uniqueidentifier NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_Id  DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_SSB_DispatchQueue     PRIMARY KEY,

        EnqueuedAtUtc       datetime2(3) NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_Enq DEFAULT (sysutcdatetime()),

        Status              nvarchar(20) NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_Status DEFAULT (N'Queued'),   -- Queued|Claimed|Completed|DeadLettered

        PriorityClass       tinyint NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_Pri DEFAULT (1),              -- 0=highest .. 3=lowest

        NextAttemptAtUtc    datetime2(3) NULL,
        AttemptCount        int NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_Att DEFAULT (0),
        LastAttemptAtUtc    datetime2(3) NULL,
        ClaimedAtUtc        datetime2(3) NULL,
        ClaimedBy           sysname NULL,
        CompletedAtUtc      datetime2(3) NULL,

        RetryEnabled        bit NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_RetE DEFAULT (0),
        MaxAttempts         int NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_MaxA DEFAULT (1),
        BackoffSeconds      int NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_Back DEFAULT (30),
        BackoffMode         nvarchar(20) NOT NULL
            CONSTRAINT DF_SSB_DispatchQueue_BkMd DEFAULT (N'Fixed'),     -- Fixed|Exponential

        DeadLetteredAtUtc   datetime2(3) NULL,

        ConversationHandle  uniqueidentifier NULL,
        MessageTypeName     sysname NULL,
        MessageBody         xml NULL
    );

    CREATE INDEX IX_SSB_DispatchQueue_Next
    ON [SSB].[DispatchQueue] (Status, NextAttemptAtUtc, PriorityClass, EnqueuedAtUtc)
    WHERE Status = N'Queued';
END
GO

-- DispatchDeadLetter
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = N'SSB' AND t.name = N'DispatchDeadLetter'
)
BEGIN
    CREATE TABLE [SSB].[DispatchDeadLetter]
    (
        DeadLetterId        uniqueidentifier NOT NULL
            CONSTRAINT DF_SSB_DispatchDeadLetter_Id  DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_SSB_DispatchDeadLetter     PRIMARY KEY,

        DeadLetteredAtUtc   datetime2(3) NOT NULL
            CONSTRAINT DF_SSB_DispatchDeadLetter_At DEFAULT (sysutcdatetime()),

        ConversationHandle  uniqueidentifier NULL,
        MessageTypeName     sysname NULL,
        MessageBody         xml NULL,
        ErrorMessage        nvarchar(2048) NULL,
        ErrorNumber         int NULL
    );
END
GO

-- ActivationErrorLog
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = N'SSB' AND t.name = N'ActivationErrorLog'
)
BEGIN
    CREATE TABLE [SSB].[ActivationErrorLog]
    (
        ActivationErrorLogId  uniqueidentifier NOT NULL
            CONSTRAINT DF_SSB_ActivationErrorLog_Id  DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_SSB_ActivationErrorLog     PRIMARY KEY,

        LoggedAtUtc           datetime2(3) NOT NULL
            CONSTRAINT DF_SSB_ActivationErrorLog_LoggedAt DEFAULT (sysutcdatetime()),

        ProcedureName         sysname NULL,
        ErrorNumber           int NULL,
        ErrorSeverity         int NULL,
        ErrorState            int NULL,
        ErrorLine             int NULL,
        ErrorMessage          nvarchar(2048) NULL,

        ConversationHandle    uniqueidentifier NULL,
        MessageTypeName       sysname NULL,
        MessageBody           xml NULL,

        HostName              nvarchar(128) NULL
            CONSTRAINT DF_SSB_ActivationErrorLog_Host DEFAULT (host_name()),
        AppName               nvarchar(128) NULL
            CONSTRAINT DF_SSB_ActivationErrorLog_App  DEFAULT (app_name())
    );

    CREATE INDEX IX_SSB_ActivationErrorLog_When
    ON [SSB].[ActivationErrorLog] (LoggedAtUtc DESC);

    CREATE INDEX IX_SSB_ActivationErrorLog_Conversation
    ON [SSB].[ActivationErrorLog] (ConversationHandle, LoggedAtUtc DESC);
END
GO

-- StreamCloseLog
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = N'SSB' AND t.name = N'StreamCloseLog'
)
BEGIN
    CREATE TABLE [SSB].[StreamCloseLog]
    (
        StreamCloseLogId     uniqueidentifier NOT NULL
            CONSTRAINT DF_SSB_StreamCloseLog_Id  DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_SSB_StreamCloseLog     PRIMARY KEY,

        ClosedAtUtc          datetime2(3) NOT NULL
            CONSTRAINT DF_SSB_StreamCloseLog_ClosedAt DEFAULT (sysutcdatetime()),

        ConversationHandle   uniqueidentifier NOT NULL,
        CorrelationId        uniqueidentifier NULL,
        Producer             nvarchar(128) NULL,
        PriorityClass        tinyint NULL,
        MessageBody          xml NULL
    );

    CREATE UNIQUE INDEX UX_SSB_StreamCloseLog_Conversation
    ON [SSB].[StreamCloseLog] (ConversationHandle);
END
GO
`;
}
