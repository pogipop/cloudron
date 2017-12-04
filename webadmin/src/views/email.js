'use strict';

angular.module('Application').controller('EmailController', ['$scope', '$location', '$rootScope', 'Client', 'AppStore', function ($scope, $location, $rootScope, Client, AppStore) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.client = Client;
    $scope.user = Client.getUserInfo();
    $scope.config = Client.getConfig();
    $scope.dnsConfig = {};
    $scope.currentRelay = {};
    $scope.relay = {};
    $scope.rbl = null;
    $scope.expectedDnsRecords = {
        mx: { },
        dkim: { },
        spf: { },
        dmarc: { },
        ptr: { }
    };
    $scope.expectedDnsRecordsTypes = [
        { name: 'MX', value: 'mx' },
        { name: 'DKIM', value: 'dkim' },
        { name: 'SPF', value: 'spf' },
        { name: 'DMARC', value: 'dmarc' },
        { name: 'PTR', value: 'ptr' }
    ];
    $scope.mailConfig = null;
    $scope.users = [];
    $scope.isPaying = false;

    $scope.showView = function (view) {
        // wait for dialog to be fully closed to avoid modal behavior breakage when moving to a different view already
        $('.modal').on('hidden.bs.modal', function () {
            $('.modal').off('hidden.bs.modal');
            $location.path(view);
        });

        $('.modal').modal('hide');
    };

    $scope.isProvider = function (provider) {
        return $scope.mailRelay.relay.provider === provider;
    };

    $scope.catchall = {
        addresses: [],
        busy: false,

        submit: function () {
            $scope.catchall.busy = true;

            Client.setCatchallAddresses($scope.catchall.addresses, function (error) {
                if (error) console.error('Unable to add catchall address.', error);

                $scope.catchall.busy = false;
            });
        }
    };

    $scope.email = {
        refreshBusy: false,

        toggle: function () {
            if ($scope.mailConfig.enabled) return $scope.email.disable();

            // show warning first
            $('#enableEmailModal').modal('show');
        },

        enable: function () {
            $('#enableEmailModal').modal('hide');

            Client.setMailConfig({ enabled: true }, function (error) {
                if (error) return console.error(error);

                $scope.mailConfig.enabled = true;
            });
        },

        disable: function () {
            Client.setMailConfig({ enabled: false }, function (error) {
                if (error) return console.error(error);

                $scope.mailConfig.enabled = false;
            });
        },

        refresh: function () {
            $scope.email.refreshBusy = true;

            collapseDnsRecords();

            showExpectedDnsRecords(function (error) {
                if (error) console.error(error);

                $scope.email.refreshBusy = false;
            });
        }
    };

    $scope.mailRelayPresets = [
        { provider: 'cloudron-smtp', name: 'Built-in SMTP server' },
        { provider: 'external-smtp', name: 'External SMTP server', host: '', port: 587 },
        { provider: 'ses-smtp', name: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587 },
        { provider: 'google-smtp', name: 'Google', host: 'smtp.gmail.com', port: 587 },
        { provider: 'mailgun-smtp', name: 'Mailgun', host: 'smtp.mailgun.org', port: 587 },
        { provider: 'postmark-smtp', name: 'Postmark', host: 'smtp.postmarkapp.com', port: 587 },
        { provider: 'sendgrid-smtp', name: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, username: 'apikey' },
    ];

    $scope.mailRelay = {
        error: null,
        success: false,
        busy: false,
        preset: $scope.mailRelayPresets[0],

        presetChanged: function () {
            $scope.mailRelay.error = null;

            $scope.mailRelay.relay.provider = $scope.mailRelay.preset.provider;
            $scope.mailRelay.relay.host = $scope.mailRelay.preset.host;
            $scope.mailRelay.relay.port = $scope.mailRelay.preset.port;
            $scope.mailRelay.relay.username = '';
            $scope.mailRelay.relay.password = '';
            $scope.mailRelay.relay.serverApiToken = '';
        },

        // form data to be set on load
        relay: {
            provider: 'cloudron-smtp',
            host: '',
            port: 25,
            username: '',
            password: '',
            serverApiToken: ''
        },

        submit: function () {
            $scope.mailRelay.error = null;
            $scope.mailRelay.busy = true;
            $scope.mailRelay.success = false;

            var data = {
                provider: $scope.mailRelay.relay.provider,
                host: $scope.mailRelay.relay.host,
                port: $scope.mailRelay.relay.port
            };

            // fill in provider specific username/password usage
            if (data.provider === 'postmark-smtp') {
                data.username = $scope.mailRelay.relay.serverApiToken;
                data.password = $scope.mailRelay.relay.serverApiToken;
            } else if (data.provider === 'sendgrid-smtp') {
                data.username = 'apikey';
                data.password = $scope.mailRelay.relay.serverApiToken;
            } else {
                data.username = $scope.mailRelay.relay.username;
                data.password = $scope.mailRelay.relay.password;
            }

            Client.setMailRelay(data, function (error) {
                $scope.mailRelay.busy = false;

                if (error) {
                    $scope.mailRelay.error = error.message;
                    return;
                }

                $scope.currentRelay = data;
                $scope.mailRelay.success = true;
                $scope.email.refresh();
            });
        }
    };

    $scope.testEmail = {
        busy: false,
        error: {},

        mailTo: '',

        clearForm: function () {
            $scope.testEmail.mailTo = '';
        },

        show: function () {
            $scope.testEmail.error = {};
            $scope.testEmail.busy = false;

            $scope.testEmail.mailTo = $scope.user.email;

            $('#testEmailModal').modal('show');
        },

        submit: function () {
            $scope.testEmail.error = {};
            $scope.testEmail.busy = true;

            Client.sentTestMail($scope.testEmail.mailTo, function (error) {
                $scope.testEmail.busy = false;

                if (error) {
                    $scope.testEmail.error.generic = error.message;
                    console.error(error);
                    $('#inputTestMailTo').focus();
                    return;
                }

                $('#testEmailModal').modal('hide');
            });
        }
    };

    function getMailConfig() {
        Client.getMailConfig(function (error, mailConfig) {
            if (error) return console.error(error);

            $scope.mailConfig = mailConfig;
        });
    }

    function getMailRelay() {
        Client.getMailRelay(function (error, relay) {
            if (error) return console.error(error);

            $scope.mailRelay.relay.provider = relay.provider;
            $scope.mailRelay.relay.host = relay.host;
            $scope.mailRelay.relay.port = relay.port;
            $scope.mailRelay.relay.username = '';
            $scope.mailRelay.relay.password = '';
            $scope.mailRelay.relay.serverApiToken = '';

            $scope.currentRelay = relay;

            if (relay.provider === 'postmark-smtp') {
                $scope.mailRelay.relay.serverApiToken = relay.username;
            } else if (relay.provider === 'sendgrid-smtp') {
                $scope.mailRelay.relay.serverApiToken = relay.password;
            } else {
                $scope.mailRelay.relay.username = relay.username;
                $scope.mailRelay.relay.password = relay.password;
            }

            for (var i = 0; i < $scope.mailRelayPresets.length; i++) {
                if ($scope.mailRelayPresets[i].provider === relay.provider) {
                    $scope.mailRelay.preset = $scope.mailRelayPresets[i];
                    break;
                }
            }
        });
    }

    function getDnsConfig() {
        Client.getDnsConfig(function (error, dnsConfig) {
            if (error) return console.error(error);

            $scope.dnsConfig = dnsConfig;
        });
    }

    function collapseDnsRecords() {
        $scope.expectedDnsRecordsTypes.forEach(function (record) {
            var type = record.value;
            $('#collapse_dns_' + type).collapse('hide');
        });

        $('#collapse_outbound_smtp').collapse('hide');
        $('#collapse_rbl').collapse('hide');
    }

    function showExpectedDnsRecords(callback) {
        callback = callback || function (error) { if (error) console.error(error); };

        Client.getEmailStatus(function (error, result) {
            if (error) return callback(error);

            $scope.relay = result.relay;
            $scope.rbl = result.rbl;

            // open the record details if they are not correct
            $scope.expectedDnsRecordsTypes.forEach(function (record) {
                var type = record.value;
                $scope.expectedDnsRecords[type] = result.dns[type] || {};

                if (!$scope.expectedDnsRecords[type].status) {
                    $('#collapse_dns_' + type).collapse('show');
                }
            });

            if (!$scope.relay.status) {
                $('#collapse_outbound_smtp').collapse('show');
            }

            if (!$scope.rbl.status) {
                $('#collapse_rbl').collapse('show');
            }

            callback(null);
        });
    }

    function getUsers() {
        Client.getUsers(function (error, result) {
            if (error) return console.error('Unable to get user listing.', error);

            // only allow users with a Cloudron email address
            $scope.catchall.availableAddresses = result.filter(function (u) { return !!u.email; }).map(function (u) { return u.username; });
        });
    }

    function getCatchallAddresses() {
        Client.getCatchallAddresses(function (error, result) {
            if (error) return console.error('Unable to get catchall address listing.', error);

            // dedupe in case to avoid angular breakage
            $scope.catchall.addresses = result.filter(function(item, pos, self) {
                return self.indexOf(item) == pos;
            });
        });
    }

    function getSubscription() {
        if ($scope.config.provider === 'caas') {
            $scope.isPaying = true;
            return;
        }

        Client.getAppstoreConfig(function (error, result) {
            if (error) return console.error(error);

            if (!result.token) return;

            AppStore.getSubscription(result, function (error, result) {
                if (error) return console.error(error);

                $scope.isPaying = result.plan.id !== 'free' && result.plan.id !== 'undecided';
            });
        });
    }

    Client.onReady(function () {
        getMailConfig();
        getMailRelay();
        getDnsConfig();
        getSubscription();
        getUsers();
        getCatchallAddresses();
        $scope.email.refresh();
    });

    // setup all the dialog focus handling
    ['testEmailModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });

    $('.modal-backdrop').remove();
}]);
