-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parentId" TEXT,
    "phase" INTEGER,
    "baseBranch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_comments" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_mirrors" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalNumber" INTEGER NOT NULL,
    "externalUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_mirrors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issues_repoOwner_repoName_state_idx" ON "issues"("repoOwner", "repoName", "state");

-- CreateIndex
CREATE UNIQUE INDEX "issues_repoOwner_repoName_number_key" ON "issues"("repoOwner", "repoName", "number");

-- CreateIndex
CREATE UNIQUE INDEX "issues_parentId_phase_key" ON "issues"("parentId", "phase");

-- CreateIndex
CREATE INDEX "issue_comments_issueId_createdAt_idx" ON "issue_comments"("issueId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "issue_mirrors_issueId_provider_key" ON "issue_mirrors"("issueId", "provider");

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_mirrors" ADD CONSTRAINT "issue_mirrors_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
