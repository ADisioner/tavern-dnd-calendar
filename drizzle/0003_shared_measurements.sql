CREATE TABLE `test_table_measurements` (
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`measurement_id` text NOT NULL,
	`payload` text NOT NULL,
	`seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`campaign_id`, `user_id`)
);
