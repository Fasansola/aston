/**
 * app/api/links/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET    /api/links  — list all links
 * POST   /api/links  — add a new link
 * PATCH  /api/links  — update a link by id
 * DELETE /api/links  — delete a link by id
 */

import { NextRequest, NextResponse } from "next/server";
import { getLinks, addLink, updateLink, deleteLink, LinkEntry } from "@/lib/storage";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const links = await getLinks();
    console.log(`[links:GET] ${links.length} links`);
    return NextResponse.json({ links });
  } catch (err) {
    console.error("[links:GET] Error:", err);
    return NextResponse.json({ error: "Failed to load links" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json() as Omit<LinkEntry, "id">;
    if (!body.url?.trim() || !body.title?.trim()) {
      return NextResponse.json({ error: "url and title are required" }, { status: 400 });
    }

    const link = await addLink({
      url:      body.url.trim(),
      title:    body.title.trim(),
      type:     body.type === "external" ? "external" : "internal",
      category: body.category?.trim() || "general",
      keywords: Array.isArray(body.keywords) ? body.keywords : [],
      anchors:  Array.isArray(body.anchors) ? body.anchors : [],
      status:   body.status === "inactive" ? "inactive" : "active",
    });
    console.log(`[links:POST] Added link ${link.id}: "${link.title}"`);
    return NextResponse.json({ link }, { status: 201 });
  } catch (err) {
    console.error("[links:POST] Error:", err);
    return NextResponse.json({ error: "Failed to add link" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { id, ...updates } = body;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const allowed = ["url", "title", "type", "category", "keywords", "anchors", "status", "language"];
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    const link = await updateLink(id, safeUpdates);
    if (!link) return NextResponse.json({ error: "Link not found" }, { status: 404 });

    console.log(`[links:PATCH] Updated link ${id}`);
    return NextResponse.json({ link });
  } catch (err) {
    console.error("[links:PATCH] Error:", err);
    return NextResponse.json({ error: "Failed to update link" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const ok = await deleteLink(id);
    if (!ok) return NextResponse.json({ error: "Link not found" }, { status: 404 });

    console.log(`[links:DELETE] Removed link ${id}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[links:DELETE] Error:", err);
    return NextResponse.json({ error: "Failed to delete link" }, { status: 500 });
  }
}
