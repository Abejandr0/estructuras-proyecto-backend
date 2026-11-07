import {MongoClient, type Collection, type Document, type Db} from 'mongodb';

const uri = process.env.MONGODB_URI;
const client = uri ? new MongoClient(uri, {serverSelectionTimeoutMS: 10_000}) : null;
export let database: Db | null = null;

export let users: Collection<Document> | null = null;
export let sessions: Collection<Document> | null = null;
export let repositories: Collection<Document> | null = null;
export let stars: Collection<Document> | null = null;
export let pullRequests: Collection<Document> | null = null;
export let reviews: Collection<Document> | null = null;
export let activities: Collection<Document> | null = null;

export async function initializeDatabase(): Promise<void> {
  if (!client) return;
  await client.connect();
  database = client.db();
  const connectedDatabase = database;
  users = connectedDatabase.collection('users');
  sessions = connectedDatabase.collection('sessions');
  repositories = connectedDatabase.collection('repositories');
  stars = connectedDatabase.collection('repository_stars');
  pullRequests = connectedDatabase.collection('pull_requests');
  reviews = connectedDatabase.collection('pull_request_reviews');
  activities = connectedDatabase.collection('activity_events');
  await Promise.all([
    users.createIndex({id: 1}, {unique: true}),
    users.createIndex({username: 1}, {unique: true}),
    users.createIndex({email: 1}, {unique: true}),
    sessions.createIndex({tokenHash: 1}, {unique: true}),
    sessions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
    sessions.createIndex({userId: 1}),
    repositories.createIndex({id: 1}, {unique: true}),
    repositories.createIndex({ownerId: 1, name: 1}, {unique: true}),
    repositories.createIndex({isPublic: 1, starsCount: -1, createdAt: -1}),
    stars.createIndex({userId: 1, repositoryId: 1}, {unique: true}),
    pullRequests.createIndex({repositoryId: 1, createdAt: -1}),
    reviews.createIndex({pullRequestId: 1, createdAt: 1}),
    activities.createIndex({createdAt: -1}),
  ]);
}
