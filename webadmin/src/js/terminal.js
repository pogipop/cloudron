'use strict';

/* global Terminal */

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

app.controller('TerminalController', ['$scope', '$timeout', '$location', 'Client', function ($scope, $timeout, $location, Client) {
    var search = decodeURIComponent(window.location.search).slice(1).split('&').map(function (item) { return item.split('='); }).reduce(function (o, k) { o[k[0]] = k[1]; return o; }, {});

    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

    $scope.apps = [];
    $scope.selected = '';
    $scope.terminal = null;
    $scope.terminalSocket = null;
    $scope.restartAppBusy = false;
    $scope.appBusy = false;
    $scope.selectedAppInfo = null;

    $scope.downloadFile = {
        error: '',
        filePath: '',
        busy: false,

        downloadUrl: function () {
            if (!$scope.downloadFile.filePath) return '';

            var filePath = $scope.downloadFile.filePath.replace(/\/*\//g, '/');

            return Client.apiOrigin + '/api/v1/apps/' + $scope.selected.value + '/download?file=' + filePath + '&access_token=' + Client.getToken();
        },

        show: function () {
            $scope.downloadFile.busy = false;
            $scope.downloadFile.error = '';
            $scope.downloadFile.filePath = '';
            $('#downloadFileModal').modal('show');
        },

        submit: function () {
            $scope.downloadFile.busy = true;

            Client.checkDownloadableFile($scope.selected.value, $scope.downloadFile.filePath, function (error) {
                $scope.downloadFile.busy = false;

                if (error) {
                    $scope.downloadFile.error = 'The requested file does not exist.';
                    return;
                }

                // we have to click the link to make the browser do the download
                // don't know how to prevent the browsers
                $('#fileDownloadLink')[0].click();

                $('#downloadFileModal').modal('hide');
            });
        }
    };

    $scope.uploadProgress = {
        busy: false,
        total: 0,
        current: 0,

        show: function () {
            $scope.uploadProgress.total = 0;
            $scope.uploadProgress.current = 0;

            $('#uploadProgressModal').modal('show');
        },

        hide: function () {
            $('#uploadProgressModal').modal('hide');
        }
    };

    $scope.uploadFile = function () {
        var fileUpload = document.querySelector('#fileUpload');

        fileUpload.onchange = function (e) {
            if (e.target.files.length === 0) return;

            $scope.uploadProgress.busy = true;
            $scope.uploadProgress.show();

            Client.uploadFile($scope.selected.value, e.target.files[0], function progress(e) {
                $scope.uploadProgress.total = e.total;
                $scope.uploadProgress.current = e.loaded;
            }, function (error) {
                if (error) console.error(error);

                $scope.uploadProgress.busy = false;
                $scope.uploadProgress.hide();
            });
        };

        fileUpload.click();
    };

    $scope.populateDropdown = function () {
        Client.getInstalledApps().forEach(function (app) {
            $scope.apps.push({
                type: 'app',
                value: app.id,
                name: app.fqdn + ' (' + app.manifest.title + ')',
                addons: app.manifest.addons
            });
        });

        // $scope.selected = $scope.apps[0];
    };

    $scope.usesAddon = function (addon) {
        if (!$scope.selected || !$scope.selected.addons) return false;
        return !!Object.keys($scope.selected.addons).find(function (a) { return a === addon; });
    };

    function reset() {
        if ($scope.terminal) {
            $scope.terminal.destroy();
            $scope.terminal = null;
        }

        if ($scope.terminalSocket) {
            $scope.terminalSocket = null;
        }

        $scope.selectedAppInfo = null;
    }

    $scope.restartApp = function () {
        $scope.restartAppBusy = true;
        var appId = $scope.selected.value;

        function waitUntilStopped(callback) {
            Client.refreshInstalledApps(function (error) {
                if (error) return callback(error);

                Client.getApp(appId, function (error, result) {
                    if (error) return callback(error);

                    if (result.runState === 'stopped') return callback();
                    setTimeout(waitUntilStopped.bind(null, callback), 2000);
                });
            });
        }

        Client.stopApp(appId, function (error) {
            if (error) return console.error('Failed to stop app.', error);

            waitUntilStopped(function (error) {
                if (error) return console.error('Failed to get app status.', error);

                Client.startApp(appId, function (error) {
                    if (error) console.error('Failed to start app.', error);

                    $scope.restartAppBusy = false;
                });
            });
        });
    };

    $scope.repairApp = function () {
        $('#repairAppModal').modal('show');
    };

    $scope.repairAppBegin = function () {
        $scope.appBusy = true;

        function waitUntilInRepairState() {
            Client.refreshInstalledApps(function (error) {
                if (error) return console.error('Failed to refresh app status.', error);

                Client.getApp($scope.selected.value, function (error, result) {
                    if (error) return console.error('Failed to get app status.', error);

                    if (result.installationState === 'installed') $scope.appBusy = false;
                    else setTimeout(waitUntilInRepairState, 2000);
                });
            });
        }

        Client.debugApp($scope.selected.value, true, function (error) {
            if (error) return console.error(error);

            Client.refreshInstalledApps(function (error) {
                if (error) console.error(error);

                $('#repairAppModal').modal('hide');

                waitUntilInRepairState();
            });
        });
    };

    $scope.repairAppDone = function () {
        $scope.appBusy = true;

        function waitUntilInNormalState() {
            Client.refreshInstalledApps(function (error) {
                if (error) return console.error('Failed to refresh app status.', error);

                Client.getApp($scope.selected.value, function (error, result) {
                    if (error) return console.error('Failed to get app status.', error);

                    if (result.installationState === 'installed') $scope.appBusy = false;
                    else setTimeout(waitUntilInNormalState, 2000);
                });
            });
        }

        Client.debugApp($scope.selected.value, false, function (error) {
            if (error) return console.error(error);

            Client.refreshInstalledApps(function (error) {
                if (error) console.error(error);

                waitUntilInNormalState();
            });
        });
    };

    function showTerminal(retry) {
        reset();

        if (!$scope.selected) return;

        var appId = $scope.selected.value;

        Client.getApp(appId, function (error, result) {
            if (error) return console.error(error);

            // we expect this to be called _after_ a reconfigure was issued
            if (result.installationState === 'pending_configure') {
                $scope.appBusy = true;
            } else if (result.installationState === 'installed') {
                $scope.appBusy = false;
            }

            $scope.selectedAppInfo = result;

            $scope.terminal = new Terminal();
            $scope.terminal.open(document.querySelector('#terminalContainer'));
            $scope.terminal.fit();

            try {
                // websocket cannot use relative urls
                var url = Client.apiOrigin.replace('https', 'wss') + '/api/v1/apps/' + $scope.selected.value + '/execws?tty=true&rows=' + $scope.terminal.rows + '&columns=' + $scope.terminal.cols + '&access_token=' + Client.getToken();
                $scope.terminalSocket = new WebSocket(url);
                $scope.terminal.attach($scope.terminalSocket);

                $scope.terminalSocket.onclose = function () {
                    // retry in one second
                    $scope.terminalReconnectTimeout = setTimeout(function () {
                        showTerminal(true);
                    }, 1000);
                };

                // Let the browser handle paste
                $scope.terminal.attachCustomKeyEventHandler(function (e) {
                    if (e.key === 'v' && (e.ctrlKey || e.metaKey)) return false;
                });
            } catch (e) {
                console.error(e);
            }

            if (retry) $scope.terminal.writeln('Reconnecting...');
            else $scope.terminal.writeln('Connecting...');
        });
    }

    $scope.terminalInject = function (addon) {
        if (!$scope.terminalSocket) return;

        var cmd;
        if (addon === 'mysql') cmd = 'mysql --user=${MYSQL_USERNAME} --password=${MYSQL_PASSWORD} --host=${MYSQL_HOST} ${MYSQL_DATABASE}';
        else if (addon === 'postgresql') cmd = 'PGPASSWORD=${POSTGRESQL_PASSWORD} psql -h ${POSTGRESQL_HOST} -p ${POSTGRESQL_PORT} -U ${POSTGRESQL_USERNAME} -d ${POSTGRESQL_DATABASE}';
        else if (addon === 'mongodb') cmd = 'mongo -u "${MONGODB_USERNAME}" -p "${MONGODB_PASSWORD}" ${MONGODB_HOST}:${MONGODB_PORT}/${MONGODB_DATABASE}';
        else if (addon === 'redis') cmd = 'redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}"';

        if (!cmd) return;

        cmd += ' ';

        $scope.terminalSocket.send(cmd);
        $scope.terminal.focus();
    };

    Client.onReady($scope.populateDropdown);

    // Client.onApps(function () {
    //     console.log('onapps')
    //     if ($scope.$$destroyed) return;
    //     if ($scope.selected.type !== 'app') return $scope.appBusy = false;

    //     var appId = $scope.selected.value;

    //     Client.getApp(appId, function (error, result) {
    //         if (error) return console.error(error);

    //         // we expect this to be called _after_ a reconfigure was issued
    //         if (result.installationState === 'pending_configure') {
    //             $scope.appBusy = true;
    //         } else if (result.installationState === 'installed') {
    //             $scope.appBusy = false;
    //         }

    //         $scope.selectedAppInfo = result;
    //     });
    // });

    // terminal right click handling
    $scope.terminalClear = function () {
        if (!$scope.terminal) return;
        $scope.terminal.clear();
        $scope.terminal.focus();
    };

    $scope.terminalCopy = function () {
        if (!$scope.terminal) return;

        // execCommand('copy') would copy any selection from the page, so do this only if terminal has a selection
        if (!$scope.terminal.getSelection()) return;

        document.execCommand('copy');
        $scope.terminal.focus();
    };

    $('.contextMenuBackdrop').on('click', function (e) {
        $('#terminalContextMenu').hide();
        $('.contextMenuBackdrop').hide();

        $scope.terminal.focus();
    });

    $('#terminalContainer').on('contextmenu', function (e) {
        if (!$scope.terminal) return true;

        e.preventDefault();

        $('.contextMenuBackdrop').show();
        $('#terminalContextMenu').css({
            display: 'block',
            left: e.pageX,
            top: e.pageY
        });

        return false;
    });

    Client.getStatus(function (error, status) {
        if (error) return $scope.error(error);

        if (!status.activated) {
            console.log('Not activated yet, closing or redirecting', status);
            window.close();
            window.location.href = '/';
            return;
        }

        Client.refreshConfig(function (error) {
            if (error) return $scope.error(error);

            // check version and force reload if needed
            if (!localStorage.version) {
                localStorage.version = Client.getConfig().version;
            } else if (localStorage.version !== Client.getConfig().version) {
                localStorage.version = Client.getConfig().version;
                window.location.reload(true);
            }

            Client.refreshInstalledApps(function (error) {
                if (error) return $scope.error(error);

                Client.getInstalledApps().forEach(function (app) {
                    $scope.apps.push({
                        type: 'app',
                        value: app.id,
                        name: app.fqdn + ' (' + app.manifest.title + ')',
                        addons: app.manifest.addons
                    });
                });

                // activate pre-selected log from query otherwise choose the first one
                $scope.selected = $scope.apps.find(function (e) { return e.value === search.id; });
                if (!$scope.selected) $scope.selected = $scope.apps[0];

                // now mark the Client to be ready
                Client.setReady();

                $scope.initialized = true;

                showTerminal();
            });
        });
    });

    // setup all the dialog focus handling
    ['downloadFileModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });
}]);
