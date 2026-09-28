import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_USER = os.getenv("SMTP_USER")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5500")


def send_invite_email(to_email: str, invited_by_name: str) -> None:
    """
    Sends a real invite email over Gmail SMTP. Requires SMTP_USER (your Gmail
    address) and SMTP_PASSWORD (a Gmail "App Password", not your normal
    password) to be set in backend/.env.
    """
    if not SMTP_USER or not SMTP_PASSWORD:
        raise RuntimeError(
            "Email is not configured yet. Set SMTP_USER and SMTP_PASSWORD "
            "in backend/.env (see .env.example) to enable sending invites."
        )

    signup_link = f"{FRONTEND_URL}/signup.html?email={to_email}"

    message = MIMEMultipart("alternative")
    message["Subject"] = f"{invited_by_name} invited you to CLOVE"
    message["From"] = SMTP_USER
    message["To"] = to_email

    text_body = (
        f"{invited_by_name} invited you to join their team on CLOVE.\n\n"
        f"Create your account here:\n{signup_link}\n"
    )
    html_body = f"""
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#5b46d8">You're invited to CLOVE</h2>
      <p><strong>{invited_by_name}</strong> invited you to join their team.</p>
      <p>
        <a href="{signup_link}"
           style="background:#5b46d8;color:#fff;padding:10px 18px;border-radius:8px;
                  text-decoration:none;display:inline-block">
          Create your account
        </a>
      </p>
      <p style="color:#6b7280;font-size:13px">Or copy this link: {signup_link}</p>
    </div>
    """

    message.attach(MIMEText(text_body, "plain"))
    message.attach(MIMEText(html_body, "html"))

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context) as server:
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.sendmail(SMTP_USER, to_email, message.as_string())
