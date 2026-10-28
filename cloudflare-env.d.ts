declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    TABLE_LOCAL_SECRET?: string;
    TABLE_LOCAL_WS_URL?: string;
  }
}
