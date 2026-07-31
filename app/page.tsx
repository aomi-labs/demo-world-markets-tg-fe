import { HandoverFlow } from '@/components/HandoverFlow';
import { botRegistrationId } from '@/lib/aomi';

export default function Home() {
  let bot: string | null = null;
  let configError: string | null = null;
  try {
    bot = botRegistrationId();
  } catch (error) {
    configError = error instanceof Error ? error.message : 'configuration error';
  }

  return (
    <main className="page">
      <header className="page__head">
        <p className="eyebrow">aomi · partner handover reference</p>
        <h1>World Markets → Telegram agent</h1>
        <p className="lede">
          The web is the custody surface. Telegram is the autonomy surface.{' '}
          <strong>Telegram never asks for a signature.</strong>
        </p>
      </header>

      {configError ? (
        <div className="banner banner--error">
          {configError}
        </div>
      ) : (
        <HandoverFlow botRegistrationId={bot!} />
      )}

      <footer className="page__foot">
        <p>
          Every call to aomi goes through this app&apos;s own route handlers — the
          platform activation bearer is server-only and never reaches the browser.
        </p>
      </footer>
    </main>
  );
}
