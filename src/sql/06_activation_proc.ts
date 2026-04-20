export function sql06ActivationProc(): string {
    return `-- =============================================================
-- 06_activation_proc.sql
-- [SSB].[usp_Activation_Inbound]
--
-- Receives messages from [SSB].[Q_Inbound].
-- Dispatches by message type:
--   - System EndDialog / Error  : END CONVERSATION (safe cleanup)
--   - [SSB].[EndOfStream]       : log to StreamCloseLog, END CONVERSATION
--   - [SSB].[FFSend]            : enqueue in DispatchQueue, END CONVERSATION immediately
--   - [SSB].[LRSend]            : enqueue in DispatchQueue (no immediate END)
--   - Invalid / unknown         : dead-letter, END CONVERSATION
-- CATCH block swallows and logs to ActivationErrorLog to prevent
-- poison-message queue disable.
-- =============================================================

CREATE OR ALTER PROCEDURE [SSB].[usp_Activation_Inbound]
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @ch         uniqueidentifier;
    DECLARE @mt         sysname;
    DECLARE @body       varbinary(max);
    DECLARE @bodyXml    xml;
    DECLARE @priority   tinyint;

    -- Loop until the queue is drained (activation model)
    WHILE (1 = 1)
    BEGIN
        BEGIN TRY

            BEGIN TRAN;

            RECEIVE TOP (1)
                @ch   = conversation_handle,
                @mt   = message_type_name,
                @body = message_body
            FROM [SSB].[Q_Inbound];

            -- Queue empty – nothing to do
            IF @ch IS NULL
            BEGIN
                ROLLBACK;
                BREAK;
            END

            -- ── System: EndDialog ───────────────────────────────────────
            IF @mt = N'http://schemas.microsoft.com/SQL/ServiceBroker/EndDialog'
            BEGIN
                END CONVERSATION @ch;
                COMMIT;
                CONTINUE;
            END

            -- ── System: Error ───────────────────────────────────────────
            IF @mt = N'http://schemas.microsoft.com/SQL/ServiceBroker/Error'
            BEGIN
                END CONVERSATION @ch;
                COMMIT;
                CONTINUE;
            END

            -- ── Parse XML body ──────────────────────────────────────────
            BEGIN TRY
                SET @bodyXml = CAST(@body AS xml);
            END TRY
            BEGIN CATCH
                -- Invalid XML envelope => dead-letter, END CONVERSATION
                INSERT INTO [SSB].[DispatchDeadLetter]
                    (ConversationHandle, MessageTypeName, ErrorMessage)
                VALUES
                    (@ch, @mt, N'Invalid XML envelope: ' + ERROR_MESSAGE());
                END CONVERSATION @ch;
                COMMIT;
                CONTINUE;
            END CATCH

            -- ── Extract PriorityClass (default 1 if missing or out of range) ─
            SET @priority = TRY_CAST(
                @bodyXml.value('(/*/PriorityClass)[1]', 'nvarchar(10)')
                AS tinyint
            );
            IF @priority IS NULL OR @priority > 3
                SET @priority = 1;

            -- ── [SSB].[EndOfStream] ──────────────────────────────────────
            IF @mt = N'[SSB].[EndOfStream]'
            BEGIN
                BEGIN TRY
                    INSERT INTO [SSB].[StreamCloseLog]
                        (ConversationHandle,
                         CorrelationId,
                         Producer,
                         PriorityClass,
                         MessageBody)
                    VALUES
                        (@ch,
                         TRY_CAST(@bodyXml.value('(/*/CorrelationId)[1]', 'nvarchar(36)') AS uniqueidentifier),
                         @bodyXml.value('(/*/Producer)[1]',      'nvarchar(128)'),
                         @priority,
                         @bodyXml);
                END TRY
                BEGIN CATCH
                    -- Ignore duplicate (unique index on ConversationHandle)
                    IF ERROR_NUMBER() <> 2601 AND ERROR_NUMBER() <> 2627
                        THROW;
                END CATCH

                END CONVERSATION @ch;
                COMMIT;
                CONTINUE;
            END

            -- ── [SSB].[FFSend] ───────────────────────────────────────────
            IF @mt = N'[SSB].[FFSend]'
            BEGIN
                INSERT INTO [SSB].[DispatchQueue]
                    (PriorityClass,
                     ConversationHandle,
                     MessageTypeName,
                     MessageBody,
                     RetryEnabled)
                SELECT
                    @priority,
                    @ch,
                    @mt,
                    @bodyXml,
                    0;   -- FF: no retry by design

                -- FF: always END CONVERSATION immediately after enqueuing
                END CONVERSATION @ch;
                COMMIT;
                CONTINUE;
            END

            -- ── [SSB].[LRSend] ───────────────────────────────────────────
            IF @mt = N'[SSB].[LRSend]'
            BEGIN
                -- Validate LR envelope; dead-letter without ack if invalid
                IF @bodyXml.exist('/LREnvelope') = 0
                BEGIN
                    INSERT INTO [SSB].[DispatchDeadLetter]
                        (ConversationHandle, MessageTypeName, MessageBody, ErrorMessage)
                    VALUES
                        (@ch, @mt, @bodyXml, N'LRSend missing /LREnvelope root');
                    END CONVERSATION @ch;
                    COMMIT;
                    CONTINUE;
                END

                DECLARE @retryEnabled bit = 0;
                IF @bodyXml.exist('/LREnvelope/Retry') = 1
                    SET @retryEnabled = 1;

                INSERT INTO [SSB].[DispatchQueue]
                    (PriorityClass,
                     ConversationHandle,
                     MessageTypeName,
                     MessageBody,
                     RetryEnabled,
                     MaxAttempts,
                     BackoffSeconds,
                     BackoffMode)
                SELECT
                    @priority,
                    @ch,
                    @mt,
                    @bodyXml,
                    @retryEnabled,
                    ISNULL(
                        TRY_CAST(@bodyXml.value('(/LREnvelope/Retry/MaxAttempts)[1]', 'nvarchar(10)') AS int),
                        1
                    ),
                    ISNULL(
                        TRY_CAST(@bodyXml.value('(/LREnvelope/Retry/BackoffSeconds)[1]', 'nvarchar(10)') AS int),
                        30
                    ),
                    ISNULL(
                        @bodyXml.value('(/LREnvelope/Retry/BackoffMode)[1]', 'nvarchar(20)'),
                        N'Fixed'
                    );

                -- LR: do NOT end conversation here; worker ends it after processing
                COMMIT;
                CONTINUE;
            END

            -- ── Unknown message type ─────────────────────────────────────
            INSERT INTO [SSB].[DispatchDeadLetter]
                (ConversationHandle, MessageTypeName, MessageBody, ErrorMessage)
            VALUES
                (@ch, @mt, @bodyXml, N'Unknown message type');
            END CONVERSATION @ch;
            COMMIT;

        END TRY
        BEGIN CATCH
            -- Swallow and log so that activation never disables the queue
            IF @@TRANCOUNT > 0 ROLLBACK;

            BEGIN TRY
                INSERT INTO [SSB].[ActivationErrorLog]
                    (ProcedureName,
                     ErrorNumber,
                     ErrorSeverity,
                     ErrorState,
                     ErrorLine,
                     ErrorMessage,
                     ConversationHandle,
                     MessageTypeName,
                     MessageBody)
                VALUES
                    (N'[SSB].[usp_Activation_Inbound]',
                     ERROR_NUMBER(),
                     ERROR_SEVERITY(),
                     ERROR_STATE(),
                     ERROR_LINE(),
                     ERROR_MESSAGE(),
                     @ch,
                     @mt,
                     @bodyXml);
            END TRY
            BEGIN CATCH
                -- If even logging fails, we still must not rethrow
            END CATCH

        END CATCH

    END -- WHILE
END
GO
`;
}
