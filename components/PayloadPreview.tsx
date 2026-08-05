'use client';

/**
 * The issue payload, exactly as `issue()` sends it.
 *
 * Shared by both views on purpose. `issueBody` is the same object the request
 * is built from, so this cannot drift from the wire — a preview that lies is
 * worse than no preview.
 *
 * In the Product view it is collapsed behind a disclosure and labelled as a
 * demo aid: a real World Markets user would never see it, and the whole point
 * of that view is to show what they *would* see. But an integrator watching
 * someone drive the product screen wants to see the JSON move as the fields
 * change, and switching tabs to check loses exactly that.
 */

export function PayloadPreview({
  body,
  label = 'Request body, exactly as sent:',
}: {
  body: unknown;
  label?: string;
}) {
  return (
    <>
      <p className="code-block__label">{label}</p>
      <pre className="code-block">{JSON.stringify(body, null, 2)}</pre>
    </>
  );
}

/** Collapsed variant for the Product view, where the JSON is a demo aid. */
export function PayloadDisclosure({ body }: { body: unknown }) {
  return (
    <details className="disclose">
      <summary className="disclose__head">
        Watch the JSON this screen produces
        <span className="disclose__note">demo aid — not part of the product UI</span>
      </summary>
      <div className="disclose__body">
        <PayloadPreview body={body} label="Updates live as you change the fields above." />
      </div>
    </details>
  );
}
