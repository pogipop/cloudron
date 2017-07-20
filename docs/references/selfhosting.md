# Overview

The Cloudron platform can be installed on public cloud servers from EC2, Digital Ocean, Hetzner,
Linode, OVH, Scaleway, Vultr etc. Cloudron also runs well on a home server or company intranet.

If you run into any trouble following this guide, ask us at our [chat](https://chat.cloudron.io).

# Understand

Before installing the Cloudron, it is helpful to understand Cloudron's design. The Cloudron
intends to make self-hosting effortless. It takes care of updates, backups, firewall, dns setup,
certificate management etc. All app and user configuration is carried out using the web interface.

This approach to self-hosting means that the Cloudron takes complete ownership of the server and
only tracks changes that were made via the web interface. Any external changes made to the server
(i.e other than via the Cloudron web interface or API) may be lost across updates.

The Cloudron requires a domain name when it is installed. Apps are installed into subdomains.
The `my` subdomain is special and is the location of the Cloudron web interface. For this to
work, the Cloudron requires a way to programmatically configure the DNS entries of the domain.
Note that the Cloudron will never overwrite _existing_ DNS entries and refuse to install
apps on existing subdomains (so, it is safe to reuse an existing domain that runs other services).

# Cloud Server

DigitalOcean and EC2 (Amazon Web Services) are frequently tested by us.

Please use the below links to support us with referrals:
* [Amazon EC2](https://aws.amazon.com/ec2/)
* [DigitalOcean](https://m.do.co/c/933831d60a1e)

In addition to those, the Cloudron community has successfully installed the platform on those providers:
* [Amazon Lightsail](https://amazonlightsail.com/)
* [hosttech](https://www.hosttech.ch/?promocode=53619290)
* [Linode](https://www.linode.com/?r=f68d816692c49141e91dd4cef3305da457ac0f75)
* [OVH](https://www.ovh.com/)
* [Rosehosting](https://secure.rosehosting.com/clientarea/?affid=661)
* [Scaleway](https://www.scaleway.com/)
* [So you Start](https://www.soyoustart.com/)
* [Vultr](http://www.vultr.com/?ref=7110116-3B)

Please let us know if any of them requires tweaks or adjustments.

# Installing

## Create server

Create an `Ubuntu 16.04 (Xenial)` server with at-least `1gb` RAM and 20GB disk space.
Do not make any changes to vanilla ubuntu. Be sure to allocate a static IPv4 address
for your server.

Cloudron has a built-in firewall and ports are opened and closed dynamically, as and when
apps are installed, re-configured or removed. For this reason, be sure to open all TCP and
UDP traffic to the server and leave the traffic management to the Cloudron.

### Kimsufi

Be sure to check the "use the distribution kernel" checkbox in the personalized installation mode.

### Linode

Since Linode does not manage SSH keys, be sure to add the public key to
`/root/.ssh/authorized_keys`.

## Run setup

SSH into your server and run the following commands:

```
wget https://cloudron.io/cloudron-setup
chmod +x cloudron-setup
./cloudron-setup --provider <azure|digitalocean|ec2|lightsail|linode|ovh|rosehosting|scaleway|vultr|generic>
```

The setup will take around 10-15 minutes.

**cloudron-setup** takes the following arguments:

* `--provider` is the name of your VPS provider. If the name is not on the list, simply
choose `generic`. In most cases, the `generic` provider mostly will work fine.
If the Cloudron does not complete initialization, it may mean that
we have to add some vendor specific quirks. Please open a
[bug report](https://git.cloudron.io/cloudron/box/issues) in that case.

Optional arguments for installation:

* `--tls-provider` is the name of the SSL/TLS certificate backend. Defaults to Let's encrypt.
Specifying `fallback` will setup the Cloudron to use the fallback wildcard certificate.
Initially a self-signed one is provided, which can be overwritten later in the admin interface.
This may be useful for non-public installations.


* `--data-dir` is the path where Cloudron will store platform and application data. Note: data
directory must be an `ext4` filesystem.

Optional arguments used for update and restore:

* `--version` is the version of Cloudron to install. By default, the setup script installs
the latest version. You can set this to an older version when restoring a Cloudron from a backup.

* `--restore-url` is a backup URL to restore from.

## Domain setup

Once the setup script completes, the server will reboot, then visit your server by its
IP address (`https://ip`) to complete the installation.

The setup website will show a certificate warning. Accept the self-signed certificate
and proceed to the domain setup.

Cloudron requires a subdomain of the [Public Suffix List](https://publicsuffix.org/).
For example, `example.com`,  `example.co.uk` will work fine.

If you want to install Cloudron on a non-registrable domain like `cloudron.example.com`,
you must purchase an Enterprise subscription. This allows for setups where you can host
multiple Cloudrons under the same top level domain like `customer1.company.com`,
`customer2.company.com` and so on.

### Route 53

Create root or IAM credentials and choose `Route 53` as the DNS provider.

* For root credentials:
  * In AWS Console, under your name in the menu bar, click `Security Credentials`
  * Click on `Access Keys` and create a key pair.
* For IAM credentials:
    * You can use the following policy to create IAM credentials:

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "route53:*",
            "Resource": [
                "arn:aws:route53:::hostedzone/<hosted zone id>"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "route53:ListHostedZones",
                "route53:GetChange"
            ],
            "Resource": [
                "*"
            ]
        }
    ]
}
```

### Digital Ocean

Create an API token with read+write access and choose `Digital Ocean` as the DNS provider.

### Other

If your domain *does not* use Route 53 or Digital Ocean, setup a wildcard (`*`) DNS `A` record that points to the
IP of the server created above. If your DNS provider has an API, please open an
[issue](https://git.cloudron.io/cloudron/box/issues) and we may be able to support it.

## Finish Setup

Once the domain setup is done, the Cloudron will configure the DNS and get a SSL certificate. It will automatically redirect to `https://my.<domain>`.

# Backups

The Cloudron creates encrypted backups once a day. Each app is backed up independently and these
backups have the prefix `app_`. The platform state is backed up independently with the
prefix `box_`.

By default, backups reside in `/var/backups`. Please note that having backups reside in the same
physical machine as the Cloudron server instance is dangerous and it must be changed to
an external storage location like `S3` as soon as possible.

## Amazon S3

Provide S3 backup credentials in the `Settings` page and leave the endpoint field empty.

Create a bucket in S3 (You have to have an account at [AWS](https://aws.amazon.com/)). The bucket can be setup to periodically delete old backups by
adding a lifecycle rule using the AWS console. S3 supports both permanent deletion
or moving objects to the cheaper Glacier storage class based on an age attribute.
With the current daily backup schedule a setting of two days should be sufficient
for most use-cases.

* For root credentials:
    * In AWS Console, under your name in the menu bar, click `Security Credentials`
    * Click on `Access Keys` and create a key pair.
* For IAM credentials:
* You can use the following policy to create IAM credentials:

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "s3:*",
            "Resource": [
                "arn:aws:s3:::<your bucket name>",
                "arn:aws:s3:::<your bucket name>/*"
            ]
        }
    ]
}
```

The `Encryption key` is an arbitrary passphrase used to encrypt the backups. Keep the passphrase safe; it is
required to decrypt the backups when restoring the Cloudron.

## Minio S3

[Minio](https://minio.io/) is a distributed object storage server, providing the same API as Amazon S3.
Since Cloudron supports S3, any API compatible solution should be supported as well, if this is not the case, let us know.

Minio can be setup, by following the [installation instructions](https://docs.minio.io/) on any server, which is reachable by the Cloudron.
Do not setup Minio on the same server as the Cloudron, this will inevitably result in data loss, if backups are stored on the same instance.

Once setup, minio will print the necessary information, like login credentials, region and endpoints in its logs.

```
$ ./minio server ./storage

Endpoint:  http://192.168.10.113:9000  http://127.0.0.1:9000
AccessKey: GFAWYNJEY7PUSLTHYHT6
SecretKey: /fEWk66E7GsPnzE1gohqKDovaytLcxhr0tNWnv3U
Region:    us-east-1
```

First create a new bucket for the backups, using the minio commandline tools or the webinterface. The bucket has to have **read and write** permissions.

The information to be copied to the Cloudron's backup settings form may look similar to:

<img src="/docs/img/minio_backup_config.png" class="shadow"><br/>

The `Encryption key` is an arbitrary passphrase used to encrypt the backups. Keep the passphrase safe; it is
required to decrypt the backups when restoring the Cloudron.

# Email

Cloudron has a built-in email server. By default, it only sends out email on behalf of apps
(for example, password reset or notification). You can enable the email server for sending
and receiving mail on the `settings` page. This feature is only available if you have setup
a DNS provider like Digital Ocean or Route53.

Your server's IP plays a big role in how emails from our Cloudron get handled. Spammers
frequently abuse public IP addresses and as a result your Cloudron might possibly start
out with a bad reputation. The good news is that most IP based blacklisting services cool
down over time. The Cloudron sets up DNS entries for SPF, DKIM, DMARC automatically and
reputation should be easy to get back.

## Checklist

* If you are unable to receive mail, first thing to check is if your VPS provider lets you
  receive mail on port 25.

    * Digital Ocean - New accounts frequently have port 25 blocked. Write to their support to
      unblock your server.

    * EC2, Lightsail & Scaleway - Edit your security group to allow email.

* Setup a Reverse DNS PTR record to be setup for the `my` subdomain.
  **Note:** PTR records are a feature of your VPS provider and not your domain provider.

    * You can verify the PTR record [https://mxtoolbox.com/ReverseLookup.aspx](here).

    * AWS EC2 & Lightsail - Fill the [PTR request form](https://aws-portal.amazon.com/gp/aws/html-forms-controller/contactus/ec2-email-limit-rdns-request).

    * Digital Ocean - Digital Ocean sets up a PTR record based on the droplet's name. So, simply rename
    your droplet to `my.<domain>`. Note that some new Digital Ocean accounts have [port 25 blocked](https://www.digitalocean.com/community/questions/port-25-smtp-external-access).

    * Linode - Follow this [guide](https://www.linode.com/docs/networking/dns/setting-reverse-dns).

    * Scaleway - Edit your security group to allow email and [reboot the server](https://community.online.net/t/security-group-not-working/2096) for the change to take effect. You can also set a PTR record on the interface with your `my.<domain>`.

* Check if your IP is listed in any DNSBL list [here](http://multirbl.valli.org/) and [here](http://www.blk.mx).
  In most cases, you can apply for removal of your IP by filling out a form at the DNSBL manager site.

* When using wildcard or manual DNS backends, you have to setup the DMARC, MX records manually.

* Finally, check your spam score at [mail-tester.com](https://www.mail-tester.com/). The Cloudron
should get 100%, if not please let us know.

# CLI Tool

The [Cloudron tool](https://git.cloudron.io/cloudron/cloudron-cli) is useful for managing
a Cloudron. <b class="text-danger">The Cloudron CLI tool has to be installed & run on a Laptop or PC</b>

Once installed, you can install, configure, list, backup and restore apps from the command line.

## Linux & OS X

Installing the CLI tool requires node.js and npm. The CLI tool can be installed using the following command:

```
npm install -g cloudron
```

Depending on your setup, you may need to run this as root.

On OS X, it is known to work with the `openssl` package from homebrew.

See [#14](https://git.cloudron.io/cloudron/cloudron-cli/issues/14) for more information.

## Windows

The CLI tool does not work on Windows. Please contact us on our [chat](https://chat.cloudron.io) if you want to help with Windows support.

# Updates

Apps installed from the Cloudron Store are automatically updated every night.

The Cloudron platform itself updates in two ways: update or upgrade.

### Update

An **update** is applied onto the running server instance. Such updates are performed
every night. You can also use the Cloudron UI to initiate an update immediately.

The Cloudron will always make a complete backup before attempting an update. In the unlikely
case an update fails, it can be [restored](/references/selfhosting.html#restore).

### Upgrade

An **upgrade** requires a new OS image. This process involves creating a new server from scratch
with the latest code and restoring it from the last backup.

To upgrade follow these steps closely:

* Create a new backup - `cloudron machine backup create`

* List the latest backup - `cloudron machine backup list`

* Make the backup available for the new cloudron instance:

  * `S3` - When storing backup ins S3, make the latest box backup public - files starting with `box_` (from v0.94.0) or `backup_`. This can be done from the AWS S3 console as seen here:

    <img src="/docs/img/aws_backup_public.png" class="shadow haze"><br/>

    Copy the new public URL of the latest backup for use as the `--restore-url` below.

    <img src="/docs/img/aws_backup_link.png" class="shadow haze"><br/>

  * `File system` - When storing backups in `/var/backups`, you have to make the box and the app backups available to the new Cloudron instance's `/var/backups`. This can be achieved in a variety of ways depending on the situation: like scp'ing the backup files to the machine before installation, mounting the external backup hard drive into the new Cloudron's `/var/backup` OR downloading a copy of the backup using `cloudron machine backup download` and uploading them to the new machine. After doing so, pass `file:///var/backups/<path to box backup>` as the `--restore-url` below.

* Create a new Cloudron by following the [installing](/references/selfhosting.html#installing) section.
  When running the setup script, pass in the `--encryption-key` and `--restore-url` flags.
  The `--encryption-key` is the backup encryption key. It can be displayed with `cloudron machine info`

Similar to the initial installation, a Cloudron upgrade looks like:
```
$ ssh root@newserverip
> wget https://cloudron.io/cloudron-setup
> chmod +x cloudron-setup
> ./cloudron-setup --provider <digitalocean|ec2|generic|scaleway> --domain <example.com> --encryption-key <key> --restore-url <publicS3Url>
```

Note: When upgrading an old version of Cloudron (<= 0.94.0), pass the `--version 0.94.1` flag and then continue updating
from that.

 * Finally, once you see the newest version being displayed in your Cloudron webinterface, you can safely delete the old server instance.

# Restore

To restore a Cloudron from a specific backup:

* Select the backup - `cloudron machine backup list`

* Make the backup public

  * `S3` - Make the box backup publicly readable - files starting with `box_` (from v0.94.0) or `backup_`. This can be done from the AWS S3 console. Once the box has restored, you can make it private again.

  * `File system` - When storing backups in `/var/backups`, you have to make the box and the app backups available to the new Cloudron instance's `/var/backups`. This can be achieved in a variety of ways depending on the situation: like scp'ing the backup files to the new machine before Cloudron installation OR mounting an external backup hard drive into the new Cloudron's `/var/backup` OR downloading a copy of the backup using `cloudron machine backup download` and uploading them to the new machine. After doing so, pass `file:///var/backups/<path to box backup>` as the `--restore-url` below.

* Create a new Cloudron by following the [installing](/references/selfhosting.html#installing) section.
  When running the setup script, pass in the `version`, `encryption-key`, `domain` and `restore-url` flags.
  The `version` field is the version of the Cloudron that the backup corresponds to (it is embedded
  in the backup file name).

* Make the box backup private, once the upgrade is complete.

# Security

Security is a core feature of the Cloudron and we continue to push out updates to tighten the Cloudron's security policy. Our goal is that Cloudron users should be able to rely on Cloudron being secure out of the box without having to do manual configuration.

This section lists various security measures in place to protect the Cloudron.

## HTTP Security

*   Cloudron admin has a CSP policy that prevents XSS attacks.
*   Cloudron set various security related HTTP headers like `X-XSS-Protection`, `X-Download-Options`,
    `X-Content-Type-Options`, `X-Permitted-Cross-Domain-Policies`, `X-Frame-Options` across all apps.

## SSL

*   Cloudron enforces HTTPS across all apps. HTTP requests are automatically redirected to
    HTTPS.
*   The Cloudron automatically installs and renews certificates for your apps as needed. Should
    installation of certificate fail for reasons beyond it's control, Cloudron admins will get a notification about it.
*   Cloudron sets the `Strict-Transport-Security` header (HSTS) to protect apps against downgrade attacks
    and cookie hijacking.
*   Cloudron has A+ rating for SSL from [SSL Labs](https://cloudron.io/blog/2017-02-22-release-0.102.0.html).

## App isolation

*   Apps are isolated completely from one another. One app cannot tamper with another apps' database or
    local files. We achieve this using Linux Containers.
*   Apps run with a read-only rootfs preventing attacks where the application code can be tampered with.
*   Apps can only connect to addons like databases, LDAP, email relay using authentication.
*   Apps are run with an AppArmor profile that disables many system calls and restricts access to `proc`
    and `sys` filesystems.
*   Most apps are run as non-root user. In the future, we intend to implement user namespaces.
*   Each app is run in it's own subdomain as opposed to sub-paths. This ensures that XSS vulnerabilities
    in one app doesn't [compromise](https://security.stackexchange.com/questions/24155/preventing-insecure-webapp-on-subdomain-compromise-security-of-main-webapp) other apps.

## Email

*   Cloudron checks against the [Zen Spamhaus DNSBL](https://www.spamhaus.org/zen/) before accepting mail.
*   Email can only be accessed with IMAP over TLS (IMAPS).
*   Email can only be relayed (including same-domain emails) by authenticated users using SMTP/STARTTLS.
*   Cloudron ensures that `MAIL FROM` is the same as the authenticated user. Users cannot spoof each other.
*   All outbound mails from Cloudron are `DKIM` signed.
*   Cloudron automatically sets up SPF, DMARC policies in the DNS for best email delivery.
*   All incoming mail is scanned via `Spamassasin`.

## Firewall

*   Cloudron blocks all incoming ports except 22 (ssh), 80 (http), 443 (https)
*   When email is enabled, Cloudron allows 25 (SMTP), 587 (MSA), 993 (IMAPS) and 4190 (WebSieve)

## OS Updates

*   Ubuntu [automatic security updates](https://help.ubuntu.com/community/AutomaticSecurityUpdates) are enabled

## Rate limits

The goal of rate limits is to prevent password brute force attacks.

*   Cloudron password verification routes - 10 requests per second per IP.
*   HTTP and HTTPS requests - 5000 requests per second per IP.
*   SSH access - 5 connections per 10 seconds per IP.
*   Email access (Port 25, 587, 993, 4190) - 50 connections per second per IP/App.
*   Database addons access - 5000 connections per second per app (addons use 128 byte passwords).
*   Email relay access - 500 connections per second per app.
*   Email receive access - 50 connections per second per app.
*   Auth addon access - 500 connections per second per app.

## Password restrictions

*   Cloudron requires user passwords to have 1 uppercase, 1 number and 1 symbol.
*   Minimum length for user passwords is 8

## Privacy

*   Cloudron apps have a default `Referrer-Policy` of `no-referrer-when-downgrade`.
*   Backups are optionally encrypted with AES-256-CBC.
*   Let's Encrypt [submits](https://letsencrypt.org/certificates/)
    all certificates to [Certificate Transparency Logs](https://www.certificate-transparency.org/).
    This means that the apps that you install and use are going to be guessable. For example,
    [crt.sh](https://crt.sh) can display all your subdomains and you can visit those subdomains and
    guess the app. Generally, this is not a problem because using hidden DNS names is not a security
    measure. If you want to avoid this, you can always use a wildcard certificate.
*   Cloudron does not collect any user information and this is not our business model. We collect
    information regarding the configured backend types. This helps us focus on improving backends
    based on their use. You can review the specific code [here](https://git.cloudron.io/cloudron/box/blob/master/src/appstore.js#L124).

# Data directory

If you are installing a brand new Cloudron, you can configure the data directory
that Cloudron uses by passing the `--data-dir` option to `cloudron-setup`.

Note: data directory must be an `ext4` filesystem.

```
./cloudron-setup --provider <digitalocean|ec2|generic|scaleway> --data-dir /var/cloudrondata
```

If you have an existing Cloudron, we recommend moving the existing data directory
to a new location as follows (`DATA_DIR` is the location to move your data):

```
    systemctl stop cloudron.target
    systemctl stop docker
    DATA_DIR="/var/data"
    mkdir -p "${DATA_DIR}"
    mv /home/yellowtent/appsdata "${DATA_DIR}"
    ln -s "${DATA_DIR}/appsdata" /home/yellowtent/appsdata
    mv /home/yellowtent/platformdata "${DATA_DIR}"
    ln -s "${DATA_DIR}/platformdata" /home/yellowtent/platformdata
    systemctl start docker
    systemctl start cloudron.target
```

# Debug

You can SSH into your Cloudron and collect logs:

* `journalctl -a -u box` to get debug output of box related code.
* `docker ps` will give you the list of containers. The addon containers are named as `mail`, `postgresql`,
   `mysql` etc. If you want to get a specific container's log output, `journalctl -a CONTAINER_ID=<container_id>`.

# Alerts

The Cloudron will notify the Cloudron administrator via email if apps go down, run out of memory, have updates
available etc.

You will have to setup a 3rd party service like [Cloud Watch](https://aws.amazon.com/cloudwatch/) or [UptimeRobot](http://uptimerobot.com/) to monitor the Cloudron itself. You can use `https://my.<domain>/api/v1/cloudron/status`
as the health check URL.

# Help

If you run into any problems, join us at our [chat](https://chat.cloudron.io) or [email us](mailto:support@cloudron.io).
