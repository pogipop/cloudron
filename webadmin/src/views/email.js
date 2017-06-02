'use strict';

angular.module('Application').controller('EmailController', ['$scope', '$location', '$rootScope', 'Client', 'AppStore', function ($scope, $location, $rootScope, Client, AppStore) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.client = Client;
    $scope.user = Client.getUserInfo();
    $scope.config = Client.getConfig();
    $scope.dnsConfig = {};
    $scope.outboundPort25 = {};
    $scope.expectedDnsRecords = {};
    $scope.expectedDnsRecordsTypes = [
        { name: 'MX', value: 'mx' },
        { name: 'DKIM', value: 'dkim' },
        { name: 'SPF', value: 'spf' },
        { name: 'DMARC', value: 'dmarc' },
        { name: 'PTR', value: 'ptr' }
    ];
    $scope.mailConfig = null;

    $scope.showView = function (view) {
        // wait for dialog to be fully closed to avoid modal behavior breakage when moving to a different view already
        $('.modal').on('hidden.bs.modal', function () {
            $('.modal').off('hidden.bs.modal');
            $location.path(view);
        });

        $('.modal').modal('hide');
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

            showExpectedDnsRecords(function (error) {
                if (error) console.error(error);

                $scope.email.refreshBusy = false;
            });
        }
    };

    function getMailConfig() {
        Client.getMailConfig(function (error, mailConfig) {
            if (error) return console.error(error);

            $scope.mailConfig = mailConfig;
        });
    }

    function getDnsConfig() {
        Client.getDnsConfig(function (error, dnsConfig) {
            if (error) return console.error(error);

            $scope.dnsConfig = dnsConfig;
        });
    }

    function showExpectedDnsRecords(callback) {
        callback = callback || function (error) { if (error) console.error(error); };

        Client.getEmailStatus(function (error, result) {
            if (error) return callback(error);

            $scope.expectedDnsRecords = result.dns;
            $scope.outboundPort25 = result.outboundPort25;

            // open the record details if they are not correct
            for (var type in $scope.expectedDnsRecords) {
                if (!$scope.expectedDnsRecords[type].status) {
                    $('#collapse_dns_' + type).collapse('show');
                }
            }

            if (!$scope.outboundPort25.status) {
                $('#collapse_dns_port').collapse('show');
            }

            callback(null);
        });
    }

    Client.onReady(function () {
        getMailConfig();
        getDnsConfig();
        $scope.email.refresh();
    });

    $('.modal-backdrop').remove();
}]);
