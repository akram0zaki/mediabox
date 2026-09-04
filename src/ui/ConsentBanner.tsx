import { useState } from 'react';

const CONSENT_KEY = 'mediabox.consent.v1';

function hasConsented(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'yes';
  } catch {
    return false;
  }
}

/**
 * First-visit notice. Non-blocking: it sits at the bottom, the app stays usable, and it
 * disappears for good once acknowledged (remembered on this device).
 */
export function ConsentBanner() {
  const [visible, setVisible] = useState(() => !hasConsented());
  const [more, setMore] = useState(false);
  if (!visible) return null;

  const accept = () => {
    try {
      localStorage.setItem(CONSENT_KEY, 'yes');
    } catch {
      /* private mode: banner will simply show again next time */
    }
    setVisible(false);
  };

  return (
    <aside className="consent" role="region" aria-label="Privacy notice">
      <div className="consent-body">
        <p>
          MediaBox runs entirely in your browser; nothing is uploaded. By using it you accept that your settings and
          your “my people” face list are stored locally on this device, and you confirm you own or have permission to
          edit the photos and videos you open.
          {!more && (
            <>
              {' '}
              <button type="button" className="consent-link" onClick={() => setMore(true)}>
                Details
              </button>
            </>
          )}
        </p>
        {more && (
          <ul className="consent-details">
            <li>Photos and videos are processed on this device only and are never sent anywhere.</li>
            <li>
              Local storage keeps this acknowledgement and the people you add (a name, small face thumbnails and
              face signatures). Remove people from the Faces panel, or clear this site’s data in your browser, to delete
              them.
            </li>
            <li>Only edit media you own or are permitted to edit, and respect the privacy of the people in it.</li>
          </ul>
        )}
      </div>
      <button type="button" className="btn btn-primary btn-small" onClick={accept}>
        Got it
      </button>
    </aside>
  );
}
