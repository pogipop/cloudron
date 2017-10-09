/* global Chart:true */

'use strict';

angular.module('Application').controller('GraphsController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.diskUsage = {};
    $scope.memoryUsageSystem = [];
    $scope.memoryUsageApps = [];
    $scope.activeApp = null;
    $scope.memoryChart = null;

    $scope.installedApps = Client.getInstalledApps();

    function bytesToGigaBytes(value) {
        return (value/1024/1024/1024).toFixed(2);
    }

    function bytesToMegaBytes(value) {
        return (value/1024/1024).toFixed(2);
    }

    // http://stackoverflow.com/questions/1484506/random-color-generator-in-javascript
    function getRandomColor() {
        var letters = '0123456789ABCDEF'.split('');
        var color = '#';
        for (var i = 0; i < 6; i++ ) {
            color += letters[Math.floor(Math.random() * 16)];
        }
        return color;
    }

    function renderDisk(type, free, reserved, used) {
        // this will mismatch df output since df -H is SI units (1000)
        $scope.diskUsage[type] = {
            used: bytesToGigaBytes(used.datapoints[0][0] + reserved.datapoints[0][0]),
            free: bytesToGigaBytes(free.datapoints[0][0]),
            sum: bytesToGigaBytes(used.datapoints[0][0] + reserved.datapoints[0][0] + free.datapoints[0][0])
        };

        var tmp = [{
            value: $scope.diskUsage[type].used,
            color: "#2196F3",
            highlight: "#82C4F8",
            label: "Used"
        }, {
            value: $scope.diskUsage[type].free,
            color:"#27CE65",
            highlight: "#76E59F",
            label: "Free"
        }];

        var ctx = $('#' + type + 'DiskUsageChart').get(0).getContext('2d');
        var myChart = new Chart(ctx);
        myChart.Doughnut(tmp);
    }

    $scope.setMemoryApp = function (app, color) {
        $scope.activeApp = app;

        var timePeriod = 12 * 60;    // in minutes
        var timeBucketSize = 60;    // in minutes

        var target;
        if (app === 'system') target = 'summarize(collectd.localhost.memory.memory-used, "' + timeBucketSize + 'min", "avg")';
        else target = 'summarize(collectd.localhost.table-' + app.id + '-memory.gauge-rss, "' + timeBucketSize + 'min", "avg")';

        Client.graphs([target], '-' + timePeriod + 'min', function (error, result) {
            if (error) return console.log(error);

            // translate the data from bytes to MB
            var data = result[0].datapoints.map(function (d) { return parseInt((d[0] / 1024 / 1024).toFixed(2)); });
            var labels = data.map(function (d, index) {
                var dateTime = new Date(Date.now() - ((timePeriod - (index * timeBucketSize)) * 60 *1000));
                return ('0' + dateTime.getHours()).slice(-2) + ':00';
            });

            var tmp = {
                labels: labels,
                datasets: [{
                    label: 'Memory',
                    fillColor: color || "#82C4F8",
                    strokeColor: color || "#2196F3",
                    pointColor: color || "rgba(151,187,205,1)",
                    pointStrokeColor: "#ffffff",
                    pointHighlightFill: color || "#82C4F8",
                    pointHighlightStroke: color || "#82C4F8",
                    data: data
                }]
            };

            var ctx = $('#memoryAppChart').get(0).getContext('2d');
            var chart = new Chart(ctx);

            var scaleStepWidth;
            if ($scope.activeApp === 'system') {
                console.log(Client.getConfig().memory);
                scaleStepWidth = Math.round(Client.getConfig().memory / (1024 * 1024) / 10); // scaleSteps is 10
            } else {
                var memoryLimit = $scope.activeApp.memoryLimit || $scope.activeApp.manifest.memoryLimit || (256 * 1024 * 1024);
                scaleStepWidth = Math.round(memoryLimit / (1024 * 1024) / 10); // scaleSteps is 10
            }

            var options = {
                scaleOverride: true,
                scaleSteps: 10,
                scaleStepWidth: scaleStepWidth,
                scaleStartValue: 0
            };

            if ($scope.memoryChart) $scope.memoryChart.destroy();
            $scope.memoryChart = chart.Line(tmp, options);
        });
    };

    $scope.updateDiskGraphs = function () {
        // https://graphite.readthedocs.io/en/latest/render_api.html#paths-and-wildcards
        // on scaleway, for some reason docker devices are collected as part of collectd
        // until we figure why just hardcode popular disk devices - https://www.mjmwired.net/kernel/Documentation/devices.txt
        Client.disks(function (error, disks) {
            if (error) return console.log(error);

            // /dev/sda1 -> sda1
            // /dev/mapper/foo -> mapper_foo (see #348)
            var appDataDiskName = disks.appsDataDisk.slice(disks.appsDataDisk.indexOf('/', 1) + 1)
            appDataDiskName = appDataDiskName.replace(/\//g, '_');

            Client.graphs([
                'absolute(collectd.localhost.df-' + appDataDiskName + '.df_complex-free)',
                'absolute(collectd.localhost.df-' + appDataDiskName + '.df_complex-reserved)',
                'absolute(collectd.localhost.df-' + appDataDiskName + '.df_complex-used)'
            ], '-1min', function (error, data) {
                if (error) return console.log(error);

                renderDisk('system', data[0], data[1], data[2]);
            });
        });
    };

    $scope.updateMemorySystemChart = function () {
        var targets = [];
        var targetsInfo = [];

        targets.push('summarize(collectd.localhost.memory.memory-used, "1min", "avg")');
        targetsInfo.push({ label: 'System', color: '#2196F3' });

        targets.push('summarize(sum(collectd.localhost.memory.memory-buffered, collectd.localhost.memory.memory-cached), "1min", "avg")');
        targetsInfo.push({ label: 'Cached', color: '#f0ad4e' });

        targets.push('summarize(collectd.localhost.memory.memory-free, "1min", "avg")');
        targetsInfo.push({ label: 'Free', color: '#27CE65' });

        Client.graphs(targets, '-1min', function (error, result) {
            if (error) return console.log(error);

            $scope.memoryUsageSystem = result.map(function (data, index) {
                return {
                    value: bytesToMegaBytes(data.datapoints[0][0]),
                    color: targetsInfo[index].color,
                    highlight: targetsInfo[index].color,
                    label: targetsInfo[index].label
                };
            });

            var ctx = $('#memoryUsageSystemChart').get(0).getContext('2d');
            var chart = new Chart(ctx).Doughnut($scope.memoryUsageSystem);

            $('#memoryUsageSystemChart').get(0).onclick = function (event) {
                $scope.setMemoryApp('system');
            };
        });
    };

    // poor man's async
    function asyncForEach(items, handler, callback) {
        var cur = 0;

        if (items.length === 0) return callback();

        (function iterator() {
            handler(items[cur], function () {
                if (cur >= items.length-1) return callback();
                ++cur;

                iterator();
            });
        })();
    }

    $scope.updateMemoryAppsChart = function () {
        var targets = [];
        var targetsInfo = [];

        $scope.installedApps.forEach(function (app) {
            targets.push('summarize(collectd.localhost.table-' + app.id + '-memory.gauge-rss, "1min", "avg")');
            targetsInfo.push({
                label: app.location || 'bare domain',
                color: getRandomColor(),
                app: app
            });
        });

        // we split up the request, to avoid too large query strings into graphite
        var tmp = [];
        var aggregatedResult= [];

        while (targets.length > 0) tmp.push(targets.splice(0, 10));

        asyncForEach(tmp, function (targets, callback) {
            Client.graphs(targets, '-1min', function (error, result) {
                if (error) return callback(error);

                aggregatedResult = aggregatedResult.concat(result);

                callback(null);
            });
        }, function (error) {
            if (error) return console.log(error);

            $scope.memoryUsageApps = aggregatedResult.map(function (data, index) {
                return {
                    value: bytesToMegaBytes(data.datapoints[0][0]),
                    color: targetsInfo[index].color,
                    highlight: targetsInfo[index].color,
                    label: targetsInfo[index].label
                };
            });

            var ctx = $('#memoryUsageAppsChart').get(0).getContext('2d');
            var chart = new Chart(ctx).Doughnut($scope.memoryUsageApps);

            $('#memoryUsageAppsChart').get(0).onclick = function (event) {
                var activeBars = chart.getSegmentsAtEvent(event);

                // dismiss non chart clicks
                if (!activeBars || !activeBars[0]) return;

                // try to find the app for this segment
                var selectedDataInfo = targetsInfo.filter(function (info) { return info.label === activeBars[0].label; })[0];
                if (selectedDataInfo) $scope.setMemoryApp(selectedDataInfo.app, selectedDataInfo.color);
            };
        });
    };

    Client.onReady($scope.updateDiskGraphs);
    Client.onReady($scope.updateMemorySystemChart);
    Client.onReady($scope.updateMemoryAppsChart);
    Client.onReady($scope.setMemoryApp.bind(null, 'system'));

    $('.modal-backdrop').remove();
}]);
