import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', {
  id:text('id').primaryKey(), login:text('login').notNull().unique(), name:text('name').notNull(),
  passwordHash:text('password_hash').notNull(), salt:text('salt').notNull(), role:text('role').notNull(),
  disabled:integer('disabled').notNull().default(0), createdAt:integer('created_at').notNull(),
});
export const logins = sqliteTable('logins', {
  tokenHash:text('token_hash').primaryKey(), userId:text('user_id').notNull().references(()=>users.id), expires:integer('expires').notNull(),
});
export const authLimits = sqliteTable('auth_limits', {
  key:text('key').primaryKey(), count:integer('count').notNull(), expires:integer('expires').notNull(),
});
export const campaigns = sqliteTable('campaigns', {
  id: text('id').primaryKey(), name: text('name').notNull(), ownerId: text('owner_id').notNull(), createdAt: integer('created_at').notNull(),
});
export const members = sqliteTable('members', {
  campaignId: text('campaign_id').notNull().references(() => campaigns.id), userId: text('user_id').notNull(),
  name: text('name').notNull(), timezone: text('timezone').notNull(), role: text('role').notNull(),
}, t => [primaryKey({ columns: [t.campaignId, t.userId] })]);
export const availability = sqliteTable('availability', {
  id: text('id').primaryKey(), campaignId: text('campaign_id').notNull().references(() => campaigns.id), userId: text('user_id').notNull(),
  start: integer('start').notNull(), end: integer('end').notNull(),
});
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), campaignId: text('campaign_id').notNull().references(() => campaigns.id),
  title: text('title').notNull(), start: integer('start').notNull(), end: integer('end').notNull(), notes: text('notes').notNull(),
});
// Experimental VTT data is isolated from calendar records and existing accounts.
export const testTableRooms = sqliteTable('test_table_rooms', {
  campaignId: text('campaign_id').primaryKey(), payload: text('payload').notNull(), version: integer('version').notNull(),
});
export const testTableMotions = sqliteTable('test_table_motions', {
  campaignId: text('campaign_id').notNull(), sceneId: text('scene_id').notNull(), tokenId: text('token_id').notNull(),
  motionId: text('motion_id').notNull().unique(), clientId: text('client_id').notNull(), userId: text('user_id').notNull(),
  name: text('name').notNull(), expectedVersion: integer('expected_version').notNull(), seq: integer('seq').notNull(),
  x: integer('x').notNull(), y: integer('y').notNull(), expires: integer('expires').notNull(), status: text('status').notNull(),
  result: text('result'),
}, t => [primaryKey({ columns: [t.campaignId, t.sceneId, t.tokenId] })]);
export const testTablePeers = sqliteTable('test_table_peers', {
  clientId: text('client_id').primaryKey(), campaignId: text('campaign_id').notNull(), userId: text('user_id').notNull(), expires: integer('expires').notNull(),
});
export const testTableAssets = sqliteTable('test_table_assets', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(), campaignId: text('campaign_id'),
  metadata: text('metadata').notNull(), size: integer('size').notNull(), archived: integer('archived').notNull(), updatedAt: integer('updated_at').notNull(),
});
