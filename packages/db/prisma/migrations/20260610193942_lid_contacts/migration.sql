-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "lidJid" TEXT;

-- CreateIndex
CREATE INDEX "Contact_lidJid_idx" ON "Contact"("lidJid");
