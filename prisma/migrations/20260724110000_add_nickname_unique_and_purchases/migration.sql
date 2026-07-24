-- Deduplicate existing nicknames before enforcing uniqueness.
-- The row with the smallest id keeps its original nickname; every later
-- duplicate is suffixed with its own id (guaranteed unique) so the
-- upcoming CREATE UNIQUE INDEX cannot fail on pre-existing data.
UPDATE "User" SET "nickname" = "nickname" || '_' || "id"
WHERE "id" NOT IN (SELECT MIN("id") FROM "User" GROUP BY "nickname");

-- CreateIndex
CREATE UNIQUE INDEX "User_nickname_key" ON "User"("nickname");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Product" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ownerId" INTEGER NOT NULL,
    "buyerId" INTEGER,
    "soldAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Product_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("id", "name", "description", "price", "category", "status", "ownerId", "createdAt", "updatedAt")
SELECT "id", "name", "description", "price", "category", "status", "ownerId", "createdAt", "updatedAt" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE INDEX "Product_status_createdAt_idx" ON "Product"("status", "createdAt");
CREATE INDEX "Product_category_price_idx" ON "Product"("category", "price");

CREATE TABLE "new_Transfer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "senderId" INTEGER NOT NULL,
    "receiverId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "memo" TEXT NOT NULL DEFAULT '',
    "productId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transfer_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transfer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Transfer" ("id", "senderId", "receiverId", "amount", "memo", "createdAt")
SELECT "id", "senderId", "receiverId", "amount", "memo", "createdAt" FROM "Transfer";
DROP TABLE "Transfer";
ALTER TABLE "new_Transfer" RENAME TO "Transfer";
CREATE UNIQUE INDEX "Transfer_productId_key" ON "Transfer"("productId");
CREATE INDEX "Transfer_senderId_createdAt_idx" ON "Transfer"("senderId", "createdAt");
CREATE INDEX "Transfer_receiverId_createdAt_idx" ON "Transfer"("receiverId", "createdAt");
PRAGMA foreign_keys=ON;
