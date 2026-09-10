import React from 'react';
import { Link } from 'react-router-dom';
import LegalPage from '../components/layout/LegalPage';

export default function TermsOfService() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        These Terms of Service (&quot;Terms&quot;) govern your access to and use of AdNexus
        (the &quot;Service&quot;), operated by MediaMonetix. By accessing or using the Service,
        you agree to these Terms.
      </p>

      <h2>1. The Service</h2>
      <p>
        AdNexus is a business dashboard that helps publishers and advertisers view reporting,
        inventory, and ROI data from connected Google Ad Manager and Google Ads accounts. Features
        may change over time as we improve the product.
      </p>

      <h2>2. Eligibility and accounts</h2>
      <ul>
        <li>You must use the Service for legitimate business purposes.</li>
        <li>You are responsible for keeping your login credentials secure.</li>
        <li>
          You must have authority to connect any Google Ad Manager or Google Ads accounts you link
          to the Service.
        </li>
      </ul>

      <h2>3. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Misuse the Service, attempt unauthorized access, or disrupt its operation.</li>
        <li>Use the Service in violation of applicable laws or Google API / product policies.</li>
        <li>Share access credentials with unauthorized parties.</li>
        <li>Reverse engineer or scrape the Service except as allowed by law.</li>
      </ul>

      <h2>4. Google and third-party services</h2>
      <p>
        The Service relies on Google APIs and your Google account permissions. Your use of Google
        products remains subject to Google&apos;s terms and policies. We are not responsible for
        outages, data accuracy issues, or policy changes originating from Google or other
        third-party providers.
      </p>

      <h2>5. Data and privacy</h2>
      <p>
        How we collect and use information is described in our{' '}
        <Link to="/privacy">Privacy Policy</Link>. You retain ownership of your advertising account
        data; you grant us permission to process it as needed to operate the Service.
      </p>

      <h2>6. Intellectual property</h2>
      <p>
        AdNexus branding, software, and interface are owned by MediaMonetix or its licensors. You
        may not copy, modify, or redistribute the Service except as expressly permitted.
      </p>

      <h2>7. Disclaimers</h2>
      <p>
        The Service is provided &quot;as is&quot; and &quot;as available.&quot; We do not warrant
        that reports will be uninterrupted, error-free, or identical to Google&apos;s native UIs at
        all times. Business decisions based on dashboard data remain your responsibility.
      </p>

      <h2>8. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, MediaMonetix and its affiliates are not liable for
        indirect, incidental, special, consequential, or punitive damages, or for lost profits,
        revenue, or data, arising from your use of the Service.
      </p>

      <h2>9. Termination</h2>
      <p>
        We may suspend or terminate access if you violate these Terms or misuse the Service. You
        may stop using the Service at any time. Provisions that by nature should survive
        (including disclaimers and liability limits) will survive termination.
      </p>

      <h2>10. Changes</h2>
      <p>
        We may update these Terms from time to time. The &quot;Last updated&quot; date will change
        when we do. Continued use after changes constitutes acceptance of the updated Terms.
      </p>

      <h2>11. Contact</h2>
      <p>
        Questions about these Terms:{' '}
        <a href="mailto:dashboard@mediamonetix.com">dashboard@mediamonetix.com</a>
        <br />
        MediaMonetix · https://mediamonetix.com
      </p>
    </LegalPage>
  );
}