/**
 * lib/social/types.ts
 * Shared interfaces for the social-publishing connector system.
 *
 * This is the media-first, character-limited sibling of lib/publishers/*.
 * Where a PublishRequest is article-shaped (title + html + markdown), a
 * SocialPost is a short caption plus media assets — the shape every social
 * platform actually wants.
 */

export type SocialTarget =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "tiktok"
  | "youtube";

/** One piece of social content, before per-platform adaptation. */
export interface SocialPost {
  /** The caption / body text. Adapted (truncated) per platform char limit. */
  text: string;
  /** Canonical blog URL to link back to. Appended (and linkified where supported). */
  link?: string;
  /** Public image URLs (e.g. S3 scene images or the featured image). */
  mediaUrls?: string[];
  /** Alt text, parallel to mediaUrls. Missing entries fall back to "". */
  altTexts?: string[];
}

export interface SocialPublishRequest {
  post: SocialPost;
  target: SocialTarget;
  targetConfig: Record<string, string>;
}

export interface SocialPublishResult {
  target: SocialTarget;
  ok: boolean;
  status: "passed" | "warning" | "failed";
  message: string;
  /** Public URL of the created post. */
  externalUrl?: string;
  /**
   * Opaque platform id used later to fetch comments or reply.
   * Facebook/Instagram: the post/media id. LinkedIn: the post URN.
   */
  platformPostId?: string;
  technicalDetails?: unknown;
}

/** A comment / reply on one of our posts, normalised across platforms. */
export interface SocialComment {
  /** Opaque id used to reply to this comment (same encoding as platformPostId). */
  id: string;
  author: string;
  text: string;
  createdAt?: string;
  url?: string;
}

export interface ListCommentsRequest {
  target: SocialTarget;
  /** platformPostId returned by publish. */
  postId: string;
  targetConfig: Record<string, string>;
}

export interface ReplyRequest {
  target: SocialTarget;
  /** The post or comment id to reply to (a platformPostId or SocialComment.id). */
  postId: string;
  text: string;
  targetConfig: Record<string, string>;
}

export interface SocialConnector {
  /** Platform hard character limit, used to warn/truncate before posting. */
  readonly charLimit: number;
  validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }>;
  publish(input: SocialPublishRequest): Promise<SocialPublishResult>;
  listComments(
    input: ListCommentsRequest
  ): Promise<{ ok: boolean; comments: SocialComment[]; message?: string }>;
  reply(input: ReplyRequest): Promise<SocialPublishResult>;
}

export interface AvailableSocialTarget {
  key: SocialTarget;
  label: string;
  description: string;
  connected: boolean;
  connectionState: "connected" | "missing_token" | "config_incomplete";
  charLimit: number;
  supportsMedia: boolean;
  /** True when the platform cannot post without a media asset (Instagram, TikTok). */
  requiresMedia: boolean;
  supportsComments: boolean;
  configFields: Array<{
    key: string;
    label: string;
    type: "text" | "select";
    required: boolean;
    placeholder?: string;
    default?: string;
    isSecret?: boolean;
    options?: Array<{ value: string; label: string }>;
  }>;
}
