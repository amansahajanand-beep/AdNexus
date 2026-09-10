import React from 'react';
import LegalPage from '../components/layout/LegalPage';

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This Privacy Policy describes how AdNexus (&quot;we&quot;, &quot;us&quot;, or &quot;the Service&quot;),
        operated by MediaMonetix, collects, uses, and shares information when you use our
        advertising analytics dashboard at dashboard.mediamonetix.com.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li>
          <strong>Account information:</strong> username, email address, and credentials you
          provide when you register or sign in.
        </li>
        <li>
          <strong>Google account data:</strong> when you connect Google services (for example
          Google Ad Manager or Google Ads via OAuth), we receive access tokens and the profile
          identifiers needed to call those APIs on your behalf. We do not receive your Google
          password.
        </li>
        <li>
          <strong>Advertising and reporting data:</strong> metrics and dimensions retrieved from
          your connected Google Ad Manager / Google Ads accounts (such as impressions, revenue,
          campaigns, and inventory) solely to display reports and dashboards you request.
        </li>
        <li>
          <strong>Usage and technical data:</strong> basic logs such as IP address, browser type,
          and timestamps, used for security, debugging, and service reliability.
        </li>
      </ul>

      <h2>2. How we use information</h2>
      <ul>
        <li>To authenticate users and provide the dashboard, reporting, and ROI features.</li>
        <li>To sync and display your Google Ad Manager and Google Ads data.</li>
        <li>To maintain security, prevent abuse, and improve the Service.</li>
        <li>To communicate about account, access, or service issues.</li>
      </ul>

      <h2>3. How we share information</h2>
      <p>We do not sell your personal information. We may share data with:</p>
      <ul>
        <li>
          <strong>Service providers</strong> that host or operate infrastructure for the Service
          (for example cloud hosting and databases), under confidentiality obligations.
        </li>
        <li>
          <strong>Google</strong>, when you authorize API access; their use of data is governed by
          Google&apos;s own policies and your Google account settings.
        </li>
        <li>
          <strong>Legal authorities</strong>, if required by law or to protect rights, safety, or
          the integrity of the Service.
        </li>
      </ul>

      <h2>4. Data retention</h2>
      <p>
        We retain account and synced reporting data for as long as your account is active and as
        needed to provide the Service. You may request deletion of your account data by contacting
        us. Cached or aggregated operational logs may be retained for a limited period for security
        and audit purposes.
      </p>

      <h2>5. Security</h2>
      <p>
        We use industry-standard measures such as encrypted transport (HTTPS), access controls, and
        session management. No method of transmission or storage is completely secure; please keep
        your credentials confidential.
      </p>

      <h2>6. Your choices</h2>
      <ul>
        <li>You can disconnect Google OAuth access from your Google Account permissions page.</li>
        <li>You can request access, correction, or deletion of account data by contacting us.</li>
        <li>You may stop using the Service at any time.</li>
      </ul>

      <h2>7. Children</h2>
      <p>
        The Service is intended for business users and is not directed to children under 16. We do
        not knowingly collect personal information from children.
      </p>

      <h2>8. Changes</h2>
      <p>
        We may update this Privacy Policy from time to time. The &quot;Last updated&quot; date at
        the top will change when we do. Continued use of the Service after changes means you accept
        the updated policy.
      </p>

      <h2>9. Contact</h2>
      <p>
        Questions about this Privacy Policy:{' '}
        <a href="mailto:dashboard@mediamonetix.com">dashboard@mediamonetix.com</a>
        <br />
        MediaMonetix · https://mediamonetix.com
      </p>
    </LegalPage>
  );
}
