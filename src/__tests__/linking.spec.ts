import { describe, expect, it, vi } from "vitest";
import {
  appleAppSiteAssociation,
  buildAppSchemeUrl,
  buildApprovalUrl,
  consumeLaunchTarget,
  digitalAssetLinks,
  expoLinkingConfig,
  parseApprovalLink,
  pwaLaunchHandler
} from "../linking.js";

const CONFIG = {
  origin: `https://example.com`,
  path: `/link`,
  scheme: `beerjournal`
};

describe(`approval URLs`, () => {
  it(`encodes an https URL, not a custom scheme`, () => {
    // WHY: THE central decision. A `myapp://` QR fails silently and
    // unrecoverably on a phone without the app — the OS camera shows "cannot
    // open" and the user has nowhere to go. An https URL opens the app when
    // installed and the web page when not, from one payload.
    const url = buildApprovalUrl(`WDJB-MJHT`, CONFIG);
    expect(url).toBe(`https://example.com/link?user_code=WDJB-MJHT`);
  });

  it(`escapes codes that need it`, () => {
    // WHY: a numeric alphabet with a `/` separator, or any future format, must
    // not break the URL it is embedded in.
    expect(buildApprovalUrl(`AB/CD EF`, CONFIG)).toContain(
      `user_code=AB%2FCD+EF`
    );
  });

  it(`builds a scheme URL only when asked`, () => {
    // WHY: the scheme exists for a deliberate "open in app" tap on the web
    // fallback page, where a failure is recoverable. Never for the QR.
    expect(buildAppSchemeUrl(`WDJB-MJHT`, CONFIG)).toBe(
      `beerjournal://link?user_code=WDJB-MJHT`
    );
    expect(() =>
      buildAppSchemeUrl(`WDJB-MJHT`, { origin: CONFIG.origin })
    ).toThrow(/no custom scheme/u);
  });
});

describe(`parseApprovalLink`, () => {
  it(`reads a code from a web link`, () => {
    expect(
      parseApprovalLink(`https://example.com/link?user_code=WDJB-MJHT`)
    ).toEqual({
      userCode: `WDJB-MJHT`,
      href: `https://example.com/link?user_code=WDJB-MJHT`,
      source: `web`
    });
  });

  it(`reads a code from a custom-scheme link`, () => {
    // WHY: an Expo app receives this through `Linking.getInitialURL()`. One
    // parser has to cover it and the universal-link form, or the host branches
    // on transport before it can even read the code.
    const parsed = parseApprovalLink(`beerjournal://link?user_code=WDJB-MJHT`, {
      scheme: `beerjournal`
    });
    expect(parsed).toMatchObject({
      userCode: `WDJB-MJHT`,
      source: `custom-scheme`
    });
  });

  it(`falls back to the last path segment`, () => {
    // WHY: path-style routes are a common design, and a custom-scheme URL often
    // carries the code as its only segment.
    expect(
      parseApprovalLink(`https://example.com/link/WDJB-MJHT`)?.userCode
    ).toBe(`WDJB-MJHT`);
  });

  it(`ignores an unregistered scheme`, () => {
    // WHY: without this, any scheme at all would be accepted — a `WIFI:` QR
    // parses as a valid URL and its payload would be read as a code.
    expect(parseApprovalLink(`beerjournal://link?user_code=X`)).toBeNull();
    expect(parseApprovalLink(`WIFI:S:cafe;T:WPA;P:hunter2;;`)).toBeNull();
  });

  it(`rejects links with no code`, () => {
    expect(parseApprovalLink(`https://example.com/`)).toBeNull();
    expect(parseApprovalLink(`not a url`)).toBeNull();
  });
});

describe(`association files`, () => {
  it(`claims the approval paths for each app`, () => {
    const aasa = appleAppSiteAssociation([
      `QQ57RJ5UTD.gg.saeris.beerjournal`
    ]) as {
      applinks: {
        apps: string[];
        details: { appID: string; paths: string[] }[];
      };
    };

    // `apps` must be present and empty — Apple deprecated its use but the
    // schema still requires the key, and omitting it invalidates the file.
    expect(aasa.applinks.apps).toEqual([]);
    expect(aasa.applinks.details[0]).toEqual({
      appID: `QQ57RJ5UTD.gg.saeris.beerjournal`,
      paths: [`/link`, `/link/*`]
    });
  });

  it(`requests the permission Android needs to skip the chooser`, () => {
    // WHY: without `handle_all_urls`, Android shows an "open with" dialog every
    // time, which users read as the link being broken.
    const links = digitalAssetLinks(`gg.saeris.beerjournal`, [`AA:BB:CC`]) as {
      relation: string[];
      target: { package_name: string; sha256_cert_fingerprints: string[] };
    }[];

    expect(links[0]?.relation).toEqual([
      `delegate_permission/common.handle_all_urls`
    ]);
    expect(links[0]?.target.package_name).toBe(`gg.saeris.beerjournal`);
  });
});

describe(`expoLinkingConfig`, () => {
  it(`omits the protocol from associatedDomains`, () => {
    // WHY: Apple's format is `applinks:example.com`. Including `https://` is a
    // silent misconfiguration — the build succeeds and links never open the app.
    const config = expoLinkingConfig(CONFIG) as {
      ios: { associatedDomains: string[] };
    };
    expect(config.ios.associatedDomains).toEqual([`applinks:example.com`]);
  });

  it(`sets autoVerify so Android opens the app directly`, () => {
    // WHY: `autoVerify` is what makes Android fetch assetlinks.json and skip
    // the chooser. Without it the app link is technically registered and
    // practically useless.
    const config = expoLinkingConfig(CONFIG) as {
      android: { intentFilters: { autoVerify: boolean; data: object[] }[] };
    };
    expect(config.android.intentFilters[0]?.autoVerify).toBe(true);
    expect(config.android.intentFilters[0]?.data[0]).toEqual({
      scheme: `https`,
      host: `example.com`,
      pathPrefix: `/link`
    });
  });

  it(`only declares a scheme when one is configured`, () => {
    expect(expoLinkingConfig({ origin: CONFIG.origin })).not.toHaveProperty(
      `scheme`
    );
  });
});

describe(`pWA launch handling`, () => {
  it(`reuses the existing window`, () => {
    // WHY: an approval screen that opened in a second window behind the one the
    // user was looking at would appear not to have worked at all.
    expect(pwaLaunchHandler()).toEqual({
      launch_handler: { client_mode: `navigate-existing` }
    });
  });

  it(`reads the launch target when the API exists`, () => {
    const onTarget = vi.fn<(href: string) => void>();
    const setConsumer = vi.fn<
      (fn: (params: { targetURL?: string }) => void) => void
    >((fn) => {
      fn({ targetURL: `https://example.com/link?user_code=WDJB-MJHT` });
    });
    vi.stubGlobal(`launchQueue`, { setConsumer });

    consumeLaunchTarget(onTarget);
    expect(onTarget).toHaveBeenCalledWith(
      `https://example.com/link?user_code=WDJB-MJHT`
    );

    vi.unstubAllGlobals();
  });

  it(`falls back to the current URL where launchQueue is unsupported`, () => {
    // WHY: Safari and Firefox have no `launchQueue` as of 2026. Without this
    // fallback the approval screen would silently do nothing on those
    // browsers — which is most of the iOS install base.
    const onTarget = vi.fn<(href: string) => void>();
    consumeLaunchTarget(onTarget, {
      currentHref: `https://example.com/link?user_code=WDJB-MJHT`
    });

    expect(onTarget).toHaveBeenCalledWith(
      `https://example.com/link?user_code=WDJB-MJHT`
    );
  });
});
