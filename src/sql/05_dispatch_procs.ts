export function sql05DispatchProcs(): string {
    return `-- =============================================================
-- 05_dispatch_procs.sql
-- Dispatch helper stored procedures:
--   [SSB].[usp_Dispatch_ClaimNext]
--   [SSB].[usp_Dispatch_Complete]
--   [SSB].[usp_Dispatch_FailAndSchedule]
-- =============================================================

-- ─── usp_Dispatch_ClaimNext ─────────────────────────────────

CREATE OR ALTER PROCEDURE [SSB].[usp_Dispatch_ClaimNext]
    @ClaimedBy          sysname,
    @DispatchId         uniqueidentifier OUTPUT,
    @PriorityClass      tinyint          OUTPUT,
    @ConversationHandle uniqueidentifier OUTPUT,
    @MessageTypeName    sysname          OUTPUT,
    @MessageBody        xml              OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Now datetime2(3) = sysutcdatetime();

    CREATE TABLE #claimed
    (
        DispatchId          uniqueidentifier NOT NULL,
        PriorityClass       tinyint          NOT NULL,
        ConversationHandle  uniqueidentifier NULL,
        MessageTypeName     sysname          NULL,
        MessageBody         xml              NOT NULL
    );

    BEGIN TRAN;

    ;WITH next_item AS
    (
        SELECT TOP (1) dq.DispatchId
        FROM [SSB].[DispatchQueue] dq WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE dq.Status = N'Queued'
          AND (dq.NextAttemptAtUtc IS NULL OR dq.NextAttemptAtUtc <= @Now)
        ORDER BY dq.PriorityClass ASC, dq.EnqueuedAtUtc ASC
    )
    UPDATE dq
        SET dq.Status           = N'Claimed',
            dq.ClaimedAtUtc     = @Now,
            dq.ClaimedBy        = @ClaimedBy,
            dq.AttemptCount     = dq.AttemptCount + 1,
            dq.LastAttemptAtUtc = @Now
    OUTPUT
        inserted.DispatchId,
        inserted.PriorityClass,
        inserted.ConversationHandle,
        inserted.MessageTypeName,
        inserted.MessageBody
    INTO #claimed
    FROM [SSB].[DispatchQueue] dq
    INNER JOIN next_item ni ON ni.DispatchId = dq.DispatchId;

    IF NOT EXISTS (SELECT 1 FROM #claimed)
    BEGIN
        COMMIT;
        SELECT
            @DispatchId         = NULL,
            @PriorityClass      = NULL,
            @ConversationHandle = NULL,
            @MessageTypeName    = NULL,
            @MessageBody        = NULL;
        RETURN 0;
    END

    SELECT TOP (1)
        @DispatchId         = DispatchId,
        @PriorityClass      = PriorityClass,
        @ConversationHandle = ConversationHandle,
        @MessageTypeName    = MessageTypeName,
        @MessageBody        = MessageBody
    FROM #claimed;

    COMMIT;
    RETURN 0;
END
GO

-- ─── usp_Dispatch_Complete ──────────────────────────────────

CREATE OR ALTER PROCEDURE [SSB].[usp_Dispatch_Complete]
    @DispatchId uniqueidentifier
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    UPDATE [SSB].[DispatchQueue]
    SET    Status          = N'Completed',
           CompletedAtUtc  = sysutcdatetime()
    WHERE  DispatchId = @DispatchId
      AND  Status     = N'Claimed';

    RETURN 0;
END
GO

-- ─── usp_Dispatch_FailAndSchedule ───────────────────────────
-- Retry logic: if <Retry> element is absent in MessageBody => RetryEnabled = 0.

CREATE OR ALTER PROCEDURE [SSB].[usp_Dispatch_FailAndSchedule]
    @DispatchId     uniqueidentifier,
    @ErrorMessage   nvarchar(2048) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Now            datetime2(3)     = sysutcdatetime();
    DECLARE @RetryEnabled   bit;
    DECLARE @MaxAttempts    int;
    DECLARE @AttemptCount   int;
    DECLARE @BackoffSeconds int;
    DECLARE @BackoffMode    nvarchar(20);
    DECLARE @MessageBody    xml;
    DECLARE @ConvHandle     uniqueidentifier;
    DECLARE @MsgTypeName    sysname;

    -- Load current row state
    SELECT
        @RetryEnabled   = RetryEnabled,
        @MaxAttempts    = MaxAttempts,
        @AttemptCount   = AttemptCount,
        @BackoffSeconds = BackoffSeconds,
        @BackoffMode    = BackoffMode,
        @MessageBody    = MessageBody,
        @ConvHandle     = ConversationHandle,
        @MsgTypeName    = MessageTypeName
    FROM [SSB].[DispatchQueue]
    WHERE DispatchId = @DispatchId;

    -- Override: if XML has no <Retry> element => no retry
    IF @MessageBody IS NOT NULL
    BEGIN
        IF @MessageBody.exist('/*/Retry') = 0
        BEGIN
            SET @RetryEnabled = 0;
        END
    END

    IF @RetryEnabled = 1 AND @AttemptCount < @MaxAttempts
    BEGIN
        DECLARE @DelaySeconds int;

        IF @BackoffMode = N'Exponential'
            SET @DelaySeconds = @BackoffSeconds * POWER(2, @AttemptCount - 1);
        ELSE
            SET @DelaySeconds = @BackoffSeconds;

        UPDATE [SSB].[DispatchQueue]
        SET    Status            = N'Queued',
               NextAttemptAtUtc  = DATEADD(SECOND, @DelaySeconds, @Now)
        WHERE  DispatchId = @DispatchId;
    END
    ELSE
    BEGIN
        -- Dead-letter
        BEGIN TRAN;

        INSERT INTO [SSB].[DispatchDeadLetter]
            (ConversationHandle, MessageTypeName, MessageBody, ErrorMessage)
        VALUES
            (@ConvHandle, @MsgTypeName, @MessageBody, @ErrorMessage);

        UPDATE [SSB].[DispatchQueue]
        SET    Status            = N'DeadLettered',
               DeadLetteredAtUtc = @Now
        WHERE  DispatchId = @DispatchId;

        COMMIT;
    END

    RETURN 0;
END
GO
`;
}
