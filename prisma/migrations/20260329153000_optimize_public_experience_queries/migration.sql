CREATE INDEX "CampaignUnlock_anonKey_campaignId_idx"
ON "CampaignUnlock"("anonKey", "campaignId");

CREATE INDEX "CampaignExperience_experienceId_sortOrder_idx"
ON "CampaignExperience"("experienceId", "sortOrder");

CREATE INDEX "Course_experienceId_isActive_sortOrder_createdAt_idx"
ON "Course"("experienceId", "isActive", "sortOrder", "createdAt");

CREATE INDEX "Course_experienceId_isActive_access_sortOrder_createdAt_idx"
ON "Course"("experienceId", "isActive", "access", "sortOrder", "createdAt");

CREATE INDEX "Lesson_courseId_isActive_sortOrder_createdAt_idx"
ON "Lesson"("courseId", "isActive", "sortOrder", "createdAt");

CREATE INDEX "Post_experienceId_isActive_idx"
ON "Post"("experienceId", "isActive");
