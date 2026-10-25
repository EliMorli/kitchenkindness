// Public privacy policy (Google's sign-in setup needs a link to one).

export const metadata = {
  title: 'Privacy Policy · Kitchen of Kindness',
  description: 'How Kitchen of Kindness uses the information people share with us.'
};

const UPDATED = 'October 15, 2026';

export default function PrivacyPage() {
  return (
    <main>
      <header className="header">
        <h1>Privacy Policy</h1>
        <p>Kitchen of Kindness · last updated {UPDATED}</p>
      </header>
      <article className="privacy">
        <h2>Who we are</h2>
        <p>
          Kitchen of Kindness is a volunteer kitchen that cooks and delivers meals to families in need. This website
          (kitchenofkindness.app) is how our volunteers sign up for deliveries and how our team organizes them.
        </p>

        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>Families who ask for meals:</strong> what you send us so we can deliver: your address and unit,
            phone number, how many people are in the household, which days suit you, and delivery or dietary notes.
          </li>
          <li>
            <strong>Volunteers:</strong> the name and contact details you sign up with, and the deliveries you choose.
          </li>
        </ul>

        <h2>Our email and Google</h2>
        <p>
          With the account owner’s permission, the app connects to the kitchen’s own Gmail account. It reads the
          emails people send to the kitchen, sends our automatic reply and our “you’ve been added” email, and files
          emails into folders. It does this only to run meal deliveries.
        </p>
        <p>
          Kitchen of Kindness’s use and transfer of information received from Google APIs adheres to the{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>

        <h2>What we never do</h2>
        <ul>
          <li>We don’t sell your information or use it for advertising.</li>
          <li>
            We share it only with the services that run this app: Supabase (our database), Vercel (our website
            hosting), Google (our email) and Anthropic’s Claude, which writes a short summary of a request for our
            team. Claude does not learn from or keep these emails for training.
          </li>
          <li>People don’t make decisions about you from automated summaries alone: a person on our team reads each request.</li>
        </ul>

        <h2>Who can see it</h2>
        <p>
          Only our kitchen team, behind a password. Delivery drivers see the address and delivery notes they need, never
          names.
        </p>

        <h2>Keeping and deleting</h2>
        <p>
          We keep your information while you receive deliveries or volunteer with us. To see, correct or delete it, reply
          to any email from us or write to the kitchen’s email address. The kitchen can disconnect its Gmail from this
          app at any time, and access can also be removed at{' '}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
            myaccount.google.com/permissions
          </a>
          .
        </p>

        <h2>Changes</h2>
        <p>If this policy changes, we’ll update this page and the date at the top.</p>
      </article>
    </main>
  );
}
