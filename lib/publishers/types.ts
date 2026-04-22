/**
 * lib/publishers/types.ts
 * Shared interfaces for the multi-platform publisher connector system.
 */

export type PublishTarget =
  | "wordpress"
  | "medium"
  | "devto"
  | "hashnode"
  | "blogger"
  | "ghost"
  | "email";

export interface PublishRequest {
  title: string;
  excerpt: string;
  html: string;
  markdown: string;
  tags: string[];
  seoTitle?: string;
  seoDescription?: string;
  featuredImageUrl?: string;
  canonicalUrl?: string;
  target: PublishTarget;
  targetConfig: Record<string, string>;
}

export interface PublishResult {
  target: PublishTarget;
  ok: boolean;
  status: "passed" | "warning" | "failed";
  message: string;
  externalUrl?: string;
  editUrl?: string;
  platformPostId?: string;
  technicalDetails?: unknown;
}

export interface PublisherConnector {
  validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }>;
  publish(input: PublishRequest): Promise<PublishResult>;
}

export interface AvailableTarget {
  key: PublishTarget;
  label: string;
  description: string;
  enabled: boolean;
  requiresAuth: boolean;
  connected: boolean;
  connectionState: "connected" | "missing_token" | "config_incomplete" | "ready";
  configFields: Array<{
    key: string;
    label: string;
    type: "text" | "select" | "email";
    required: boolean;
    placeholder?: string;
    options?: Array<{ value: string; label: string }>;
    default?: string;
    isSecret?: boolean;
  }>;
}
