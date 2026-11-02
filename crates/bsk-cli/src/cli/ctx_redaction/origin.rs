/// What is known about the page a reply was rendered from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    PasswordManager,
    Other,
    Unknown,
}

impl Origin {
    /// Whether every suffix must be redacted (R1).
    pub fn redacts_all(self) -> bool {
        !matches!(self, Origin::Other)
    }
}

/// Password-manager web apps: the domain itself and every subdomain.
const PASSWORD_MANAGER_DOMAINS: &[&str] = &[
    "1password.com",
    "1password.ca",
    "1password.eu",
    "1passwordusercontent.com",
    "bitwarden.com",
    "bitwarden.eu",
    "lastpass.com",
    "keepersecurity.com",
    "keepersecurity.eu",
    "dashlane.com",
    "nordpass.com",
];

/// Password-manager web apps on hosts whose parent domain serves other apps.
const PASSWORD_MANAGER_HOSTS: &[&str] = &["passwords.google.com", "pass.proton.me"];

const ONEPASSWORD_EXTENSION_IDS: &[&str] = &[
    "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
    "dppgmdbiimibapkepcbdbmkaabgiofem",
    "khgocmkkpikpnmmkgmdnfckapcdkgfaf",
];

/// Classify a tab URL. Anything that cannot be parsed as `scheme://host...`
/// is `Unknown`, never `Other`.
pub fn classify_url(url: Option<&str>) -> Origin {
    let Some(url) = url.map(str::trim).filter(|u| !u.is_empty()) else {
        return Origin::Unknown;
    };
    let Some((scheme, rest)) = url.split_once("://") else {
        return Origin::Unknown;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = host_port
        .split(':')
        .next()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() {
        return Origin::Unknown;
    }
    let scheme = scheme.to_ascii_lowercase();
    if scheme == "chrome-extension" {
        return if ONEPASSWORD_EXTENSION_IDS.contains(&host.as_str()) {
            Origin::PasswordManager
        } else {
            Origin::Other
        };
    }
    let password_manager = PASSWORD_MANAGER_HOSTS.contains(&host.as_str())
        || PASSWORD_MANAGER_DOMAINS
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if password_manager {
        Origin::PasswordManager
    } else {
        Origin::Other
    }
}
