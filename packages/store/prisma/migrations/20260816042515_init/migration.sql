-- CreateTable
CREATE TABLE "pipeline_launches" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_launches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipeline_launches_workflowId_idx" ON "pipeline_launches"("workflowId");
