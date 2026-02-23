CREATE TABLE `agent_instance` (
	`id` text PRIMARY KEY,
	`team_session_id` text NOT NULL,
	`session_id` text,
	`role` text NOT NULL,
	`prompt` text NOT NULL,
	`expertise` text NOT NULL,
	`workspace_read` text NOT NULL,
	`workspace_write` text NOT NULL,
	`relationships` text NOT NULL,
	`status` text NOT NULL,
	`steps_used` integer NOT NULL,
	`tokens_consumed` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_agent_instance_team_session_id_team_session_id_fk` FOREIGN KEY (`team_session_id`) REFERENCES `team_session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_agent_instance_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`)
);
--> statement-breakpoint
CREATE TABLE `review_thread` (
	`id` text PRIMARY KEY,
	`team_session_id` text NOT NULL,
	`artifact_ref` text NOT NULL,
	`author_role` text NOT NULL,
	`reviewer_role` text NOT NULL,
	`status` text NOT NULL,
	`round` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_review_thread_team_session_id_team_session_id_fk` FOREIGN KEY (`team_session_id`) REFERENCES `team_session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `team_message` (
	`id` text PRIMARY KEY,
	`team_session_id` text NOT NULL,
	`from_role` text NOT NULL,
	`to_role` text,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`ref_ids` text,
	`workspace_mutations` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_team_message_team_session_id_team_session_id_fk` FOREIGN KEY (`team_session_id`) REFERENCES `team_session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `team_session` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`goal` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`sharing_strategy` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_team_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY,
	`team_session_id` text NOT NULL,
	`section` text NOT NULL,
	`content` text NOT NULL,
	`last_updated_by` text,
	`version` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_workspace_team_session_id_team_session_id_fk` FOREIGN KEY (`team_session_id`) REFERENCES `team_session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `agent_instance_team_idx` ON `agent_instance` (`team_session_id`);--> statement-breakpoint
CREATE INDEX `review_thread_session_idx` ON `review_thread` (`team_session_id`);--> statement-breakpoint
CREATE INDEX `team_message_session_idx` ON `team_message` (`team_session_id`,`time_created`);--> statement-breakpoint
CREATE INDEX `team_session_project_idx` ON `team_session` (`project_id`);--> statement-breakpoint
CREATE INDEX `workspace_session_section_idx` ON `workspace` (`team_session_id`,`section`);