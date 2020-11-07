import ApiManagementClient from "azure-arm-apimanagement";
import { isLeft, toError } from "fp-ts/lib/Either";
import { isNone } from "fp-ts/lib/Option";
import {
  IResponseErrorForbiddenNotAuthorized,
  IResponseErrorInternal,
  IResponseErrorNotFound,
  IResponseSuccessJson,
  IResponseSuccessRedirectToResource,
  ResponseErrorForbiddenNotAuthorized,
  ResponseErrorInternal,
  ResponseErrorNotFound,
  ResponseSuccessJson,
  ResponseSuccessRedirectToResource
} from "italia-ts-commons/lib/responses";
import {
  CIDR,
  FiscalCode,
  NonEmptyString,
  OrganizationFiscalCode
} from "italia-ts-commons/lib/strings";
import { ServicePublic } from "../../generated/api/ServicePublic";
import { APIClient, toEither } from "../api_client";
import {
  getApimUser,
  getUserSubscription,
  IExtendedUserContract,
  isAdminUser
} from "../apim_operations";
import { AdUser } from "../bearer_strategy";
import * as config from "../config";

import { pick, withDefault } from "italia-ts-commons/lib/types";
import { Service } from "../../generated/api/Service";
import { logger } from "../logger";

import * as t from "io-ts";
import { DepartmentName } from "../../generated/api/DepartmentName";
import { MaxAllowedPaymentAmount } from "../../generated/api/MaxAllowedPaymentAmount";
import { OrganizationName } from "../../generated/api/OrganizationName";

import { ServiceMetadata } from "../../generated/api/ServiceMetadata";
import { ServiceName } from "../../generated/api/ServiceName";

import { Logo as ApiLogo } from "../../generated/api/Logo";

import {
  fromLeft,
  fromPredicate,
  taskEither,
  TaskEither,
  tryCatch
} from "fp-ts/lib/TaskEither";

import { identity } from "fp-ts/lib/function";

export const ServicePayload = t.partial({
  authorized_cidrs: t.readonlyArray(CIDR, "array of CIDR"),
  authorized_recipients: t.readonlyArray(FiscalCode, "array of FiscalCode"),
  department_name: DepartmentName,
  is_visible: withDefault(t.boolean, false),
  max_allowed_payment_amount: MaxAllowedPaymentAmount,
  organization_fiscal_code: OrganizationFiscalCode,
  organization_name: OrganizationName,
  service_metadata: ServiceMetadata,
  service_name: ServiceName
});
export type ServicePayload = t.TypeOf<typeof ServicePayload>;

const notificationApiClient = APIClient(config.adminApiUrl, config.adminApiKey);

export type ErrorResponses =
  | IResponseErrorNotFound
  | IResponseErrorForbiddenNotAuthorized
  | IResponseErrorInternal;

const getApimUserTask = (
  apiClient: ApiManagementClient,
  authenticatedUser: AdUser
): TaskEither<ErrorResponses, IExtendedUserContract> =>
  tryCatch(
    () => getApimUser(apiClient, authenticatedUser.emails[0]),
    errors => ResponseErrorInternal(toError(errors).message)
  ).foldTaskEither<ErrorResponses, IExtendedUserContract>(
    error => fromLeft(error),
    response =>
      response.isSome()
        ? taskEither.of(response.value)
        : fromLeft(
            ResponseErrorNotFound(
              "API user not found",
              "Cannot find a user in the API management with the provided email address"
            )
          )
  );

const checkAdminTask = (
  userAdmin: IExtendedUserContract
): TaskEither<ErrorResponses, IExtendedUserContract> =>
  fromPredicate(
    (user: IExtendedUserContract) => isAdminUser(user),
    _ => ResponseErrorForbiddenNotAuthorized
  )(userAdmin);

const uploadServiceLogoTask = (
  serviceId: NonEmptyString,
  serviceLogo: ApiLogo
): TaskEither<ErrorResponses, IResponseSuccessRedirectToResource<{}, {}>> =>
  tryCatch(
    () =>
      notificationApiClient.uploadServiceLogo({
        logo: serviceLogo,
        serviceId
      }),
    errors => ResponseErrorInternal(toError(errors).message)
  ).foldTaskEither(
    error => fromLeft(error),
    errorOrResponse =>
      errorOrResponse && errorOrResponse.status === 201
        ? taskEither.of(
            ResponseSuccessRedirectToResource(
              {},
              `${config.logoUrl}/services/${serviceId}.png`,
              {}
            )
          )
        : fromLeft(ResponseErrorInternal(toError(errorOrResponse).message))
  );

const uploadOrganizationLogoTask = (
  organizationfiscalcode: NonEmptyString,
  serviceLogo: ApiLogo
): TaskEither<ErrorResponses, IResponseSuccessRedirectToResource<{}, {}>> =>
  tryCatch(
    () =>
      notificationApiClient.uploadOrganizationLogo({
        logo: serviceLogo,
        organizationfiscalcode
      }),
    errors => ResponseErrorInternal(toError(errors).message)
  ).foldTaskEither(
    err => fromLeft(err),
    errorOrResponse =>
      errorOrResponse && errorOrResponse.status === 201
        ? taskEither.of(
            ResponseSuccessRedirectToResource(
              {},
              `${config.logoUrl}/services/${organizationfiscalcode}.png`,
              {}
            )
          )
        : fromLeft(ResponseErrorInternal(toError(errorOrResponse).message))
  );

/**
 * Get service data for a specific serviceId.
 */
export async function getService(
  apiClient: ApiManagementClient,
  authenticatedUser: AdUser,
  serviceId: NonEmptyString
): Promise<
  | IResponseSuccessJson<Service>
  | IResponseErrorForbiddenNotAuthorized
  | IResponseErrorInternal
  | IResponseErrorNotFound
> {
  const maybeApimUser = await getApimUser(
    apiClient,
    authenticatedUser.emails[0]
  );
  if (isNone(maybeApimUser)) {
    return ResponseErrorNotFound(
      "API user not found",
      "Cannot find a user in the API management with the provided email address"
    );
  }
  const apimUser = maybeApimUser.value;

  // Authenticates this request against the logged in user
  // checking that serviceId = subscriptionId
  // if the user is an admin we skip the check on userId
  const maybeSubscription = await getUserSubscription(
    apiClient,
    serviceId,
    isAdminUser(apimUser) ? undefined : apimUser.id
  );

  if (isNone(maybeSubscription)) {
    return ResponseErrorInternal("Cannot get user subscription");
  }

  const errorOrServiceResponse = toEither(
    await notificationApiClient.getService({
      id: serviceId
    })
  );

  if (isLeft(errorOrServiceResponse)) {
    return ResponseErrorNotFound(
      "Cannot get service",
      "Cannot get existing service"
    );
  }
  const service = errorOrServiceResponse.value;
  return ResponseSuccessJson(service);
}

/**
 * Update service data for/with a specific serviceId.
 */
export async function putService(
  apiClient: ApiManagementClient,
  authenticatedUser: AdUser,
  serviceId: NonEmptyString,
  servicePayload: ServicePayload
): Promise<
  | IResponseSuccessJson<ServicePublic>
  | IResponseErrorForbiddenNotAuthorized
  | IResponseErrorInternal
  | IResponseErrorNotFound
> {
  const maybeApimUser = await getApimUser(
    apiClient,
    authenticatedUser.emails[0]
  );
  if (isNone(maybeApimUser)) {
    return ResponseErrorNotFound(
      "API user not found",
      "Cannot find a user in the API management with the provided email address"
    );
  }
  const authenticatedApimUser = maybeApimUser.value;

  // Authenticates this request against the logged in user
  // checking that serviceId = subscriptionId
  // if the user is an admin we skip the check on userId
  const maybeSubscription = await getUserSubscription(
    apiClient,
    serviceId,
    isAdminUser(authenticatedApimUser) ? undefined : authenticatedApimUser.id
  );
  if (isNone(maybeSubscription)) {
    return ResponseErrorNotFound(
      "Subscription not found",
      "Cannot get a subscription for the logged in user"
    );
  }

  // Get old service data
  const errorOrService = toEither(
    await notificationApiClient.getService({
      id: serviceId
    })
  );
  if (isLeft(errorOrService)) {
    return ResponseErrorNotFound(
      "Service not found",
      "Cannot get a service with the provided id."
    );
  }
  const service = errorOrService.value;

  logger.debug(
    "updating service %s",
    JSON.stringify({ ...service, ...servicePayload })
  );
  const payload = !isAdminUser(authenticatedApimUser)
    ? pick(
        [
          "department_name",
          "organization_fiscal_code",
          "organization_name",
          "service_name"
        ],
        servicePayload
      )
    : servicePayload;

  const errorOrUpdatedService = toEither(
    await notificationApiClient.updateService({
      service: { ...service, ...payload },
      serviceId
    })
  );

  return errorOrUpdatedService.fold<
    IResponseErrorInternal | IResponseSuccessJson<ServicePublic>
  >(
    errs => ResponseErrorInternal("Error updating service: " + errs.message),
    ResponseSuccessJson
  );
}

/**
 * Upload service logo for/with a specific serviceId.
 */
export async function putServiceLogo(
  apiClient: ApiManagementClient,
  authenticatedUser: AdUser,
  serviceId: NonEmptyString,
  serviceLogo: ApiLogo
): Promise<IResponseSuccessRedirectToResource<{}, {}> | ErrorResponses> {
  return getApimUserTask(apiClient, authenticatedUser)
    .chain(user =>
      checkAdminTask(user).chain(() =>
        uploadServiceLogoTask(serviceId, serviceLogo).map(result => result)
      )
    )
    .fold<IResponseSuccessRedirectToResource<{}, {}> | ErrorResponses>(
      identity,
      identity
    )
    .run();
}

/**
 * Upload organization logo for/with a specific serviceId.
 */
export async function putOrganizationLogo(
  apiClient: ApiManagementClient,
  authenticatedUser: AdUser,
  organizationfiscalcode: NonEmptyString,
  serviceLogo: ApiLogo
): Promise<IResponseSuccessRedirectToResource<{}, {}> | ErrorResponses> {
  return getApimUserTask(apiClient, authenticatedUser)
    .chain(user =>
      checkAdminTask(user).chain(() =>
        uploadOrganizationLogoTask(organizationfiscalcode, serviceLogo).map(
          result => result
        )
      )
    )
    .fold<IResponseSuccessRedirectToResource<{}, {}> | ErrorResponses>(
      identity,
      identity
    )
    .run();
}
