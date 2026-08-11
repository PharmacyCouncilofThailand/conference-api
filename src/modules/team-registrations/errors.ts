export interface TeamRegistrationFieldError {
  path: string;
  code: string;
}

export class TeamRegistrationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: TeamRegistrationFieldError[],
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TeamRegistrationError";
  }
}
