import { z } from 'zod';

const normalizedEmailSchema = z
    .string()
    .trim()
    .email('Invalid email address');

export const abstractStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'revision']);

export const abstractRevisionTopicSchema = z.enum([
    'title',
    'keywords',
    'background',
    'objective',
    'methods',
    'results',
    'conclusion',
    'documents',
    'other',
]);

// Co-Author validation schema
export const coAuthorSchema = z.object({
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
    email: normalizedEmailSchema,
    institution: z.string().min(1, 'Institution is required'),
    country: z.string().optional(),
});

// Abstract submission validation schema
export const abstractSubmissionSchema = z.object({
    // Author Information
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
    email: normalizedEmailSchema,
    affiliation: z.string().min(1, 'Affiliation is required'),
    country: z.string().optional(),
    phone: z.string().optional(),

    // Abstract Details
    title: z.string().min(10, 'Title must be at least 10 characters').max(500, 'Title too long'),
    categoryId: z.coerce.number().int().positive({ message: 'Category is required' }),
    presentationType: z.enum(['oral', 'poster']),
    keywords: z.string().min(1, 'Keywords are required'),

    // Abstract Content (word count validation will be done separately)
    background: z.string().min(1, 'Background is required'),
    objective: z.string().min(1, 'Objective is required'),
    methods: z.string().min(1, 'Methods are required'),
    results: z.string().min(1, 'Results are required'),
    conclusion: z.string().min(1, 'Conclusion is required'),

    // Co-Authors (optional, will be parsed from JSON string in multipart)
    coAuthors: z.array(coAuthorSchema).optional().default([]),

    // Event Code (e.g. "PRIS-2026")
    eventCode: z.string().optional(),
});

export const abstractResubmissionSchema = z.object({
    title: z.string().min(10, 'Title must be at least 10 characters').max(500, 'Title too long'),
    categoryId: z.coerce.number().int().positive({ message: 'Category is required' }),
    presentationType: z.enum(['oral', 'poster']),
    keywords: z.string().min(1, 'Keywords are required'),
    background: z.string().min(1, 'Background is required'),
    objective: z.string().min(1, 'Objective is required'),
    methods: z.string().min(1, 'Methods are required'),
    results: z.string().min(1, 'Results are required'),
    conclusion: z.string().min(1, 'Conclusion is required'),
    coAuthors: z.array(coAuthorSchema).optional().default([]),
    eventCode: z.string().optional(),
});

const liveTitleSchema = z.string().max(500, 'Title too long').default('');
const liveKeywordsSchema = z.string().max(2000, 'Keywords too long').default('');
const liveSectionSchema = z
    .string()
    .max(20000, 'Abstract section too long')
    .default('');

export const abstractWordCountRequestSchema = z.object({
    title: liveTitleSchema,
    keywords: liveKeywordsSchema,
    background: liveSectionSchema,
    objective: liveSectionSchema,
    methods: liveSectionSchema,
    results: liveSectionSchema,
    conclusion: liveSectionSchema,
});

// Backoffice: List abstracts
export const abstractListSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(1000).default(10),
    search: z.string().optional(),
    eventId: z.coerce.number().optional(),
    status: abstractStatusSchema.optional(),
    categoryId: z.coerce.number().optional(),
    presentationType: z.enum(['oral', 'poster']).optional(),
    trackingId: z.string().min(1).max(80).optional(),
    trackingMatch: z.enum(['any', 'canonical', 'alias']).default('any'),
    submittedFrom: z.string().datetime().optional(),
    submittedBefore: z.string().datetime().optional(),
    archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
});

// Backoffice: Update abstract status
export const updateAbstractStatusSchema = z.object({
    status: z.enum(['pending', 'accepted', 'rejected']),
    comment: z.string().optional(), // For review comment
});

export const requestAbstractRevisionSchema = z.object({
    topic: z.string().trim().min(1, 'Revision topic is required').max(255, 'Revision topic must be 255 characters or fewer'),
    comment: z.string().trim().max(1000, 'Revision details must be 1000 characters or fewer').optional().default(''),
});
