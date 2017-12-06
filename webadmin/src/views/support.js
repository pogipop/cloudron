'use strict';

angular.module('Application').controller('SupportController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

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
                $scope.feedback.error = error.message;
            } else {
                $scope.feedback.success = true;
                resetFeedback();
            }

            $scope.feedback.busy = false;
        });
    };

    var CLOUDRON_SUPPORT_PUBLIC_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDQVilclYAIu+ioDp/sgzzFz6YU0hPcRYY7ze/LiF/lC7uQqK062O54BFXTvQ3ehtFZCx3bNckjlT2e6gB8Qq07OM66De4/S/g+HJW4TReY2ppSPMVNag0TNGxDzVH8pPHOysAm33LqT2b6L/wEXwC6zWFXhOhHjcMqXvi8Ejaj20H1HVVcf/j8qs5Thkp9nAaFTgQTPu8pgwD8wDeYX1hc9d0PYGesTADvo6HF4hLEoEnefLw7PaStEbzk2fD3j7/g5r5HcgQQXBe74xYZ/1gWOX2pFNuRYOBSEIrNfJEjFJsqk3NR1+ZoMGK7j+AZBR4k0xbrmncQLcQzl6MMDzkp support@cloudron.io';
    var CLOUDRON_SUPPORT_PUBLIC_KEY_IDENTIFIER = 'support@cloudron.io';

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
