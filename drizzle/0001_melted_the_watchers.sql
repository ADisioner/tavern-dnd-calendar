CREATE TABLE `test_table_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`campaign_id` text,
	`metadata` text NOT NULL,
	`size` integer NOT NULL,
	`archived` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_table_motions` (
	`campaign_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`token_id` text NOT NULL,
	`motion_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`expected_version` integer NOT NULL,
	`seq` integer NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`expires` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	PRIMARY KEY(`campaign_id`, `scene_id`, `token_id`)
);
--> statement-breakpoint
CREATE TABLE `test_table_peers` (
	`client_id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_table_rooms` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`version` integer NOT NULL
);
