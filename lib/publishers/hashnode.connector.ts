import type { PublisherConnector, PublishRequest, PublishResult } from "@/lib/publishers/types";

const GQL_ENDPOINT = "https://gql.hashnode.com/";

async function gqlRequest<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data: T; errors?: { message: string }[] }> {
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Hashnode API returned ${res.status}`);
  return res.json() as Promise<{ data: T; errors?: { message: string }[] }>;
}

const PUBLISH_MUTATION = `
  mutation PublishPost($input: PublishPostInput!) {
    publishPost(input: $input) {
      post {
        id
        url
      }
    }
  }
`;

const VALIDATE_QUERY = `
  query {
    me {
      id
      username
    }
  }
`;

export default class HashnodeConnector implements PublisherConnector {
  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!config.token) errors.push("token is required");
    if (!config.publicationId) errors.push("publicationId is required");

    if (errors.length > 0) return { ok: false, errors };

    try {
      const result = await gqlRequest<{ me: { id: string } }>(config.token, VALIDATE_QUERY, {});
      if (result.errors?.length) {
        errors.push(`Hashnode token validation failed: ${result.errors[0].message}`);
      }
    } catch (e) {
      errors.push(`Failed to reach Hashnode API: ${String(e)}`);
    }

    return { ok: errors.length === 0, errors };
  }

  async publish(input: PublishRequest): Promise<PublishResult> {
    const { title, markdown, tags, canonicalUrl, target, targetConfig: config } = input;

    const hashnodeTags = tags.map((t) => ({
      name: t,
      slug: t.toLowerCase().replace(/[^a-z0-9]/g, "-"),
    }));

    const publishInput: Record<string, unknown> = {
      title,
      publicationId: config.publicationId,
      contentMarkdown: markdown,
      tags: hashnodeTags,
    };

    const effectiveCanonical = config.canonicalUrl || canonicalUrl;
    if (effectiveCanonical) publishInput.originalArticleURL = effectiveCanonical;

    try {
      const result = await gqlRequest<{
        publishPost: { post: { id: string; url: string } };
      }>(config.token, PUBLISH_MUTATION, { input: publishInput });

      if (result.errors?.length) {
        return {
          target,
          ok: false,
          status: "failed",
          message: `Hashnode publish failed: ${result.errors[0].message}`,
          technicalDetails: result.errors,
        };
      }

      const post = result.data.publishPost.post;

      return {
        target,
        ok: true,
        status: "passed",
        message: "Published to Hashnode successfully",
        externalUrl: post.url,
        platformPostId: post.id,
        technicalDetails: post,
      };
    } catch (e) {
      return {
        target,
        ok: false,
        status: "failed",
        message: `Unexpected error: ${String(e)}`,
      };
    }
  }
}
