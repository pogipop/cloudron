# Cloudron

[Cloudron](https://cloudron.io) is the best way to run apps on your server.

Web applications like email, contacts, blog, chat are the backbone of the modern
internet. Yet, we live in a world where hosting these essential applications is
a complex task.

We are building the ultimate platform for self-hosting web apps. The Cloudron allows
anyone to effortlessly host web applications on their server on their own terms.

## Features

* Single click install for apps. Check out the [App Store](https://cloudron.io/appstore.html).

* Per-app encrypted backups and restores.

* App updates delivered via the App Store.

* Secure - Cloudron manages the firewall. All apps are secured with HTTPS. Certificates are
  installed and renewed automatically.

* Centralized User & Group management. Control who can access which app.

* Single Sign On. Use same credentials across all apps.

* Automatic updates for the Cloudron platform.

* Trivially migrate to another server keeping your apps and data (for example, switch your
  infrastructure provider or move to a bigger server).

* Comprehensive [REST API](https://cloudron.io/documentation/developer/api/).

* [CLI](https://cloudron.io/documentation/cli/) to configure apps.

* Alerts, audit logs, graphs, dns management ... and much more

## Demo

Try our demo at https://my.demo.cloudron.io (username: cloudron password: cloudron).

## Installing

[Install script](https://cloudron.io/documentation/installation/) - [Pricing](https://cloudron.io/pricing.html)

**Note:** This repo is a small part of what gets installed on your server - there is
the dashboard, database addons, graph container, base image etc. Cloudron also relies
on external services such as the App Store for apps to be installed. As such, don't
clone this repo and npm install and expect something to work.

## Documentation

* [Documentation](https://cloudron.io/documentation/)

## Related repos

The [base image repo](https://git.cloudron.io/cloudron/docker-base-image) is the parent image of all
the containers in the Cloudron.

## Community

* [Chat](https://chat.cloudron.io)
* [Forum](https://forum.cloudron.io/)
* [Support](mailto:support@cloudron.io)

