-- CreateTable
CREATE TABLE "CrmIntegration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "crmType" TEXT NOT NULL,
    "credentials" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LeadMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "crmIntegrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unmatched',
    "crmRecordType" TEXT,
    "crmRecordId" TEXT,
    "crmRecordName" TEXT,
    "crmRecordUrl" TEXT,
    "crmNoteId" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LeadMapping_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LeadMapping_crmIntegrationId_fkey" FOREIGN KEY ("crmIntegrationId") REFERENCES "CrmIntegration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "crmIntegrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncLog_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SyncLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SyncLog_crmIntegrationId_fkey" FOREIGN KEY ("crmIntegrationId") REFERENCES "CrmIntegration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadMapping_contactId_crmIntegrationId_key" ON "LeadMapping"("contactId", "crmIntegrationId");

-- CreateIndex
CREATE INDEX "SyncLog_conversationId_status_idx" ON "SyncLog"("conversationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SyncLog_messageId_crmIntegrationId_key" ON "SyncLog"("messageId", "crmIntegrationId");
