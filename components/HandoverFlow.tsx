'use client';

/**
 * The handover, in two vocabularies.
 *
 * `useHandover` owns the entire state machine; both views are pure
 * presentation over the same hook instance. Switching the toggle mid-flow
 * keeps your place — it is the same handover, described differently:
 *
 *   Product     — what a World Markets user reads before approving custody.
 *   Integration — the wire format their engineers implement against.
 *
 * Keeping one machine is the point. If the two views could drift, the demo
 * would eventually show a flow the backend does not implement.
 */

import { useState } from 'react';

import { IntegrationView } from './IntegrationView';
import { ProductView } from './ProductView';
import { useHandover } from '@/lib/useHandover';

type View = 'product' | 'integration';

export function HandoverFlow({ botRegistrationId }: { botRegistrationId: string }) {
  const [view, setView] = useState<View>('product');
  const h = useHandover(botRegistrationId);

  return (
    <>
      <div className="viewswitch" role="tablist" aria-label="View">
        <button
          role="tab"
          aria-selected={view === 'product'}
          className={`viewswitch__tab ${view === 'product' ? 'is-on' : ''}`}
          onClick={() => setView('product')}
        >
          Product
          <small>what the user sees</small>
        </button>
        <button
          role="tab"
          aria-selected={view === 'integration'}
          className={`viewswitch__tab ${view === 'integration' ? 'is-on' : ''}`}
          onClick={() => setView('integration')}
        >
          Integration
          <small>what you implement</small>
        </button>
      </div>

      {view === 'product' ? <ProductView h={h} /> : <IntegrationView h={h} />}
    </>
  );
}
