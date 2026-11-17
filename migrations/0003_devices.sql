-- Device profiles (see shared/devices.ts). A test case runs on one device; a captured screen remembers
-- the device it was taken on. Existing rows are desktop. Runs keep the device in their environment JSON.
ALTER TABLE test_cases ADD COLUMN device TEXT NOT NULL DEFAULT 'desktop';
ALTER TABLE uis ADD COLUMN device TEXT NOT NULL DEFAULT 'desktop';
