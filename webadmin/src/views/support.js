'use strict';

angular.module('Application').controller('SupportController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    $scope.config = Client.getConfig();

    $scope.feedback = {
        error: null,
        success: false,
        busy: false,
        subject: '',
        type: '',
        description: ''
    };

    $scope.sshSupportEnabled = false;

    function resetFeedback() {
        $scope.feedback.subject = '';
        $scope.feedback.description = '';
        $scope.feedback.type = '';

        $scope.feedbackForm.$setUntouched();
        $scope.feedbackForm.$setPristine();
    }

    $scope.submitFeedback = function () {
        $scope.feedback.busy = true;
        $scope.feedback.success = false;
        $scope.feedback.error = null;

        Client.feedback($scope.feedback.type, $scope.feedback.subject, $scope.feedback.description, function (error) {
            if (error) {
                $scope.feedback.error = error;
            } else {
                $scope.feedback.success = true;
                resetFeedback();
            }

            $scope.feedback.busy = false;
        });
    };

    var CLOUDRON_SUPPORT_PUBLIC_KEY = '';
    var CLOUDRON_SUPPORT_PUBLIC_KEY_IDENTIFIER = '';

    $scope.toggleSshSupport = function () {
        if ($scope.sshSupportEnabled) {
            Client.delAuthorizedKey(CLOUDRON_SUPPORT_PUBLIC_KEY_IDENTIFIER, function (error) {
                if (error) return console.error(error);
                $scope.sshSupportEnabled = false;
            });
        } else {
            Client.addAuthorizedKey(CLOUDRON_SUPPORT_PUBLIC_KEY, function (error) {
                if (error) return console.error(error);
                $scope.sshSupportEnabled = true;
            });
        }
    };

    Client.onReady(function () {
        Client.getAuthorizedKeys(function (error, keys) {
            if (error) return console.error(error);

            $scope.sshSupportEnabled = keys.some(function (k) { return k.key === CLOUDRON_SUPPORT_PUBLIC_KEY; });
        });
    });

    $('.modal-backdrop').remove();
}]);
