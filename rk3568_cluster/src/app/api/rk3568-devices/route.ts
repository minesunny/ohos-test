import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { getRk3568ClientHubPublicUrl } from "@/lib/rk3568-client-hub";
import {
  listRk3568RegisteredClients,
  listRk3568RegisteredDevices,
} from "@/lib/rk3568-test";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const clients = listRk3568RegisteredClients();
    const devices = listRk3568RegisteredDevices();

    return NextResponse.json({
      clientWsUrl: getRk3568ClientHubPublicUrl(request.url),
      clients,
      devices,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch RK3568 clients/devices.",
      },
      { status: 500 },
    );
  }
}
