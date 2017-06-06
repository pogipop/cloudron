'use strict';

angular.module('Application').controller('MainController', ['$scope', '$route', '$interval', '$timeout', 'Client', 'AppStore', function ($scope, $route, $interval, $timeout, Client, AppStore) {
    $scope.initialized = false;
    $scope.user = Client.getUserInfo();
    $scope.installedApps = Client.getInstalledApps();
    $scope.config = {};
    $scope.status = {};
    $scope.client = Client;
    $scope.currentSubscription = null;
    $scope.appstoreConfig = {};

    $scope.update = {
        busy: false,
        error: {},
        password: ''
    };

    $scope.isActive = function (url) {
        if (!$route.current) return false;
        return $route.current.$$route.originalPath.indexOf(url) === 0;
    };

    $scope.logout = function (event) {
        event.stopPropagation();
        $scope.initialized = false;
        Client.logout();
    };

    $scope.error = function (error) {
        console.error(error);
        window.location.href = '/error.html';
    };

    $scope.showUpdateModalFromVersion1Modal = function () {
        $('#version1Modal').modal('hide');
        $('#updateModal').modal('show');
    };

    $scope.showUpdateModal = function (form) {
        $scope.update.error.generic = null;
        $scope.update.error.password = null;
        $scope.update.password = '';

        form.$setPristine();
        form.$setUntouched();


        if ($scope.currentSubscription.plan && $scope.currentSubscription.plan.id === 'free') {
            if ($scope.config.update.box.version === '1.0.0') {
                $('#version1Modal').modal('show');
            } else {
                $('#setupSubscriptionModal').modal('show');
            }
        } else {
            $('#updateModal').modal('show');
        }
    };

    $scope.doUpdate = function () {
        $scope.update.error.generic = null;
        $scope.update.error.password = null;

        $scope.update.busy = true;
        Client.update($scope.update.password, function (error) {
            if (error) {
                if (error.statusCode === 403) {
                    $scope.update.error.password = true;
                    $scope.update.password = '';
                    $scope.update_form.password.$setPristine();
                    $('#inputUpdatePassword').focus();
                } else if (error.statusCode === 409) {
                    $scope.update.error.generic = 'Please try again later. The Cloudron is creating a backup at the moment.';
                    $scope.update.password = '';
                    $scope.update_form.password.$setPristine();
                    $('#inputUpdatePassword').focus();
                } else {
                    $scope.update.error.generic = error.message;
                    console.error('Unable to update.', error);
                }
                $scope.update.busy = false;
                return;
            }

            window.location.href = '/update.html';
        });
    };

    function runConfigurationChecks() {
        Client.getDnsConfig(function (error, result) {
            if (error) return console.error(error);

            var actionScope;

            // warn user if dns config is not working (the 'configuring' flag detects if configureWebadmin is 'active')
            if (!$scope.status.webadminStatus.configuring && !$scope.status.webadminStatus.dns) {
                actionScope = $scope.$new(true);
                actionScope.action = '/#/certs';
                Client.notify('Invalid Domain Config', 'Unable to update DNS. Click here to update it.', true, 'error', actionScope);
            }

            if (result.provider === 'caas') return;

            // Check if all email DNS records are set up properly only for non external DNS API
            Client.getEmailStatus(function (error, result) {
                if (error) return console.error(error);

                if (!result.dns.spf.status || !result.dns.dkim.status || !result.dns.ptr.status || !result.outboundPort25.status) {
                    var actionScope = $scope.$new(true);
                    actionScope.action = '/#/email';

                    Client.notify('DNS Configuration', 'Please setup all required DNS records to guarantee correct mail delivery', false, 'info', actionScope);
                }
            });
        });
    }

    function getSubscription() {
        Client.getAppstoreConfig(function (error, result) {
            if (error) return console.error(error);

            if (result.token) {
                $scope.appstoreConfig = result;

                AppStore.getProfile(result.token, function (error, result) {
                    if (error) return console.error(error);

                    $scope.appstoreConfig.profile = result;

                    AppStore.getSubscription($scope.appstoreConfig, function (error, result) {
                        if (error) return console.error(error);

                        $scope.currentSubscription = result;

                        // check again to give more immediate feedback once a subscription was setup
                        if (result.plan.id === 'free') $timeout(getSubscription, 5000);
                    });
                });
            }
        });
    }

    Client.getStatus(function (error, status) {
        if (error) return $scope.error(error);

        // WARNING if anything about the routing is changed here test these use-cases:
        //
        // 1. Caas
        // 2. selfhosted with --domain argument
        // 3. selfhosted restore
        // 4. local development with gulp develop

        if (!status.activated) {
            console.log('Not activated yet, redirecting', status);
            window.location.href = status.adminFqdn ? '/setup.html' : '/setupdns.html';
            return;
        }

        // support local development with localhost check
        if (window.location.hostname !== status.adminFqdn && window.location.hostname !== 'localhost') {
            window.location.href = '/setupdns.html';
            return;
        }

        $scope.status = status;

        Client.refreshConfig(function (error) {
            if (error) return $scope.error(error);

            // check version and force reload if needed
            if (!localStorage.version) {
                localStorage.version = Client.getConfig().version;
            } else if (localStorage.version !== Client.getConfig().version) {
                localStorage.version = Client.getConfig().version;
                window.location.reload(true);
            }


            Client.refreshUserInfo(function (error) {
                if (error) return $scope.error(error);

                Client.refreshInstalledApps(function (error) {
                    if (error) return $scope.error(error);

                    // kick off installed apps and config polling
                    var refreshAppsTimer = $interval(Client.refreshInstalledApps.bind(Client), 5000);
                    var refreshConfigTimer = $interval(Client.refreshConfig.bind(Client), 5000);
                    var refreshUserInfoTimer = $interval(Client.refreshUserInfo.bind(Client), 5000);

                    $scope.$on('$destroy', function () {
                        $interval.cancel(refreshAppsTimer);
                        $interval.cancel(refreshConfigTimer);
                        $interval.cancel(refreshUserInfoTimer);
                    });

                    // now mark the Client to be ready
                    Client.setReady();

                    $scope.config = Client.getConfig();

                    $scope.initialized = true;

                    if ($scope.user.admin) {
                        runConfigurationChecks();

                        if ($scope.config.provider !== 'caas') getSubscription();
                    }
                });
            });
        });
    });

    // wait till the view has loaded until showing a modal dialog
    Client.onConfig(function (config) {
        // check if we are actually updating
        if (config.progress.update && config.progress.update.percent !== -1) {
            window.location.href = '/update.html';
        }

        if (config.cloudronName) {
            document.title = config.cloudronName;
        }
    });

    // setup all the dialog focus handling
    ['updateModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });
}]);
